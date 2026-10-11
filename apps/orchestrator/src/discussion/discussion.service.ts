import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { isTerminalStatus } from '@lds/shared';
import { AgentExecutor } from '../agent/agent-executor';
import { AgentRegistryService } from '../agent-registry/agent-registry.service';
import { matchAgent } from '../channels/agent-match';
import { AppConfigService } from '../config/app-config.service';
import { AgentEventBus } from '../bus/agent-event-bus';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { encodeAttachments } from '../prisma/agent-event-attachments';
import { isBuiltinAgent } from '../agent-registry/agent-registry.service';
import { AGREED_MARK, allAgreed, buildSummaryPrompt, buildTurnPrompt, cleanLanguage, cleanParticipants, cleanRounds, stripMark, type DiscussionLanguage, type Turn } from './discussion-core';

interface Active {
  taskId: string;
  topic: string;
  agents: string[];
  rounds: number;
  summaryBy: string | null;
  language: DiscussionLanguage;
  turns: Turn[];
  /** 1-based number of the turn being played (0 before the first) */
  turn: number;
  total: number;
  speaker: string | null;
  human: string[];
  stop: boolean;
  conclude: boolean;
  attachments?: string[];
  /** next sequence number for lines we write ourselves (after the agents' own, which count up from 0) */
  seq: number;
}

export interface DiscussionState {
  active: boolean;
  topic?: string;
  agents?: string[];
  turn?: number;
  total?: number;
  speaker?: string | null;
  summaryBy?: string | null;
  language?: DiscussionLanguage;
}

/**
 * Round-table mode: several agents talk to each other in ONE chat (a task). Each turn is a real, short agent run of the speaker (read-only,
 * conversational) that sees the topic and the conversation so far; the reply is stored as a message by that speaker. The human can join in at any
 * time, ask for the conclusion early, or stop it. At the end one agent (optionally) writes the summary.
 */
@Injectable()
export class DiscussionService {
  private readonly logger = new Logger(DiscussionService.name);
  private readonly active = new Map<string, Active>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: AgentEventBus,
    private readonly tasks: TasksService,
    private readonly executor: AgentExecutor,
    private readonly agents: AgentRegistryService,
    private readonly config: AppConfigService,
  ) {}

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  state(taskId: string): DiscussionState {
    const a = this.active.get(taskId);
    return a ? { active: true, topic: a.topic, agents: a.agents, turn: a.turn, total: a.total, speaker: a.speaker, summaryBy: a.summaryBy, language: a.language } : { active: false };
  }

  /** `expert_codex` / `Expert-Codex` / a small typo → the agent's real name; an error that lists the agents otherwise. */
  private async resolveNames(names: string[]): Promise<string[]> {
    const list = await this.agents.list();
    const pick = (n: string): string => {
      if (list.some((a) => a.name === n)) return n;
      const m = matchAgent(n, list);
      if (m.kind === 'exact' || m.kind === 'fuzzy') return m.name;
      throw new BadRequestException(`No agent named "${n}". Agents: ${list.filter((a) => !isBuiltinAgent(a.name)).map((a) => a.name).join(', ') || 'none'}.`);
    };
    return names.map((n) => {
      const name = pick(n);
      if (isBuiltinAgent(name)) throw new BadRequestException(`"${name}" is a built-in agent and cannot take part in a discussion.`);
      return name;
    });
  }

  /** Begin a discussion in an existing chat (task) or in a new one. Returns at once; the turns play in the background. */
  async start(input: { taskId?: string; topic?: string; agents?: unknown; rounds?: unknown; language?: unknown; summaryBy?: string | null; attachments?: string[]; createdById?: string; createdByChannel?: string }): Promise<{ taskId: string }> {
    const topic = String(input.topic ?? '').trim();
    if (!topic) throw new BadRequestException('Say what the agents should discuss.');
    const cleaned = cleanParticipants(input.agents);
    if ('error' in cleaned) throw new BadRequestException(cleaned.error);
    const agents = await this.resolveNames(cleaned.agents);
    if (new Set(agents).size < 2) throw new BadRequestException('Pick at least 2 different agents to discuss.');
    const summaryBy = input.summaryBy ? (await this.resolveNames([input.summaryBy]))[0]! : null;
    const rounds = cleanRounds(input.rounds);

    let taskId = input.taskId;
    if (taskId) {
      const task = await this.tasks.get(taskId);
      if (this.active.has(taskId)) throw new ConflictException('A discussion is already running in this chat.');
      if (!isTerminalStatus(task.status)) throw new ConflictException('This chat is busy — wait until the agent has finished, then start the discussion.');
    } else {
      const created = await this.tasks.create({ prompt: topic, title: `Discussion: ${topic.split('\n')[0]!.slice(0, 70)}`, agentName: agents[0], autostart: false, kind: 'discussion', ...(input.createdByChannel ? { createdByChannel: input.createdByChannel } : {}) } as never, input.createdById);
      taskId = created.id;
    }
    const a: Active = { taskId, topic, agents, rounds, summaryBy, language: cleanLanguage(input.language), turns: [], turn: 0, total: agents.length * rounds + (summaryBy ? 1 : 0), speaker: null, human: [], stop: false, conclude: false, attachments: input.attachments, seq: 1_000_000 };
    this.active.set(taskId, a);
    await this.tasks.setStatus(taskId, 'running');
    void this.play(a).catch((e) => this.logger.error(`Discussion in ${taskId} crashed: ${(e as Error).message}`));
    this.logger.log(`Discussion started in ${taskId}: ${agents.join(', ')} × ${rounds} round(s)`);
    return { taskId };
  }

  /** The human says something while the agents talk — it joins the conversation and is answered first. */
  async interject(taskId: string, text: string): Promise<{ queued: boolean }> {
    const a = this.active.get(taskId);
    if (!a) throw new NotFoundException('No discussion is running in this chat.');
    const t = text.trim();
    if (!t) throw new BadRequestException('Write something.');
    a.human.push(t);
    // show it in the conversation right away (attached to the latest turn's session)
    const session = await this.prisma.agentSession.findFirst({ where: { taskId }, orderBy: { startedAt: 'desc' }, select: { id: true } });
    if (session) {
      const seq = a.seq++;
      await this.prisma.agentEvent
        .create({ data: { agentSessionId: session.id, taskId, seq, kind: 'prompt', text: t, attachments: encodeAttachments(this.config, []) as string[] } })
        .catch((e) => this.logger.warn(`Could not store the message in ${taskId}: ${(e as Error).message}`));
      this.bus.publish({ type: 'agent-log', payload: { taskId, agentSessionId: session.id, kind: 'prompt', text: t, seq, ts: new Date().toISOString() } });
    }
    return { queued: true };
  }

  /** "Wrap up": skip the remaining turns and go to the conclusion. */
  conclude(taskId: string): { ok: true } {
    const a = this.active.get(taskId);
    if (!a) throw new NotFoundException('No discussion is running in this chat.');
    a.conclude = true;
    return { ok: true };
  }

  /** Stop right away (the turn in progress is aborted) without a conclusion. */
  async stop(taskId: string): Promise<{ ok: true }> {
    const a = this.active.get(taskId);
    if (!a) throw new NotFoundException('No discussion is running in this chat.');
    a.stop = true;
    this.executor.cancel(taskId);
    return { ok: true };
  }

  // ------------------------------------------------------------ the loop

  /** Where the participants run: an empty folder of their own, not the data root (audit logs, other tasks' files, credentials). */
  private async scratchDir(taskId: string): Promise<string> {
    const dir = join(this.config.agentDir, 'runs', taskId, 'discussion');
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async halted(a: Active): Promise<boolean> {
    if (a.stop) return true;
    const task = await this.prisma.task.findUnique({ where: { id: a.taskId }, select: { status: true } });
    return !task || task.status === 'cancelled';
  }

  /** One turn: run the speaker, return what it said (null = it could not answer). */
  private async turnOf(a: Active, speaker: string, prompt: string, opening?: boolean): Promise<string | null> {
    a.speaker = speaker;
    const collect: { text: string; error?: string } = { text: '' };
    const outcome = await this.executor.run({
      taskId: a.taskId,
      worktreePath: await this.scratchDir(a.taskId),
      branch: '',
      followUpPrompt: prompt,
      discussion: { agent: speaker, collect, ...(opening ? { opening: { text: a.topic, attachments: a.attachments } } : {}) },
    });
    // an error is never a reply (the executor keeps it out of `collect.text` and records it in `collect.error`)
    if (outcome.errored || collect.error || !collect.text.trim()) {
      this.logger.warn(`Discussion ${a.taskId}: ${speaker} could not answer (${(collect.error ?? outcome.finalText ?? 'error').slice(0, 200)})`);
      return null;
    }
    return collect.text.trim();
  }

  private async play(a: Active): Promise<void> {
    let failures = 0;
    let ended: 'done' | 'cancelled' | 'failed' = 'done';
    try {
      const turnsTotal = a.agents.length * a.rounds;
      for (let i = 0; i < turnsTotal && !a.conclude; i++) {
        if (await this.halted(a)) {
          ended = 'cancelled';
          break;
        }
        // what the human said since the last turn goes into the conversation first
        for (const h of a.human.splice(0)) a.turns.push({ speaker: 'Human', text: h });
        const speaker = a.agents[i % a.agents.length]!;
        a.turn = i + 1;
        const prompt = buildTurnPrompt({ topic: a.topic, speaker, participants: a.agents, turns: a.turns, turnNumber: i + 1, totalTurns: turnsTotal, humanHint: true, language: a.language });
        const text = await this.turnOf(a, speaker, prompt, i === 0);
        if (await this.halted(a)) {
          ended = 'cancelled';
          break;
        }
        if (text === null) {
          if (++failures >= 2) {
            await this.note(a, `⚠️ The discussion stopped: ${speaker} could not answer (check its provider).`);
            ended = 'failed';
            break;
          }
          continue;
        }
        failures = 0;
        a.turns.push({ speaker, text: stripMark(text), agreed: text.includes(AGREED_MARK) });
        if (allAgreed(a.turns, a.agents)) {
          await this.note(a, '✅ Everyone agrees — the discussion ends early.');
          break;
        }
      }
      if (ended === 'done' && a.summaryBy && !a.stop && !(await this.halted(a))) {
        for (const h of a.human.splice(0)) a.turns.push({ speaker: 'Human', text: h });
        a.turn = a.total;
        const text = await this.turnOf(a, a.summaryBy, buildSummaryPrompt({ topic: a.topic, speaker: a.summaryBy, participants: a.agents, turns: a.turns }));
        if (text) a.turns.push({ speaker: a.summaryBy, text: stripMark(text) });
      }
    } catch (e) {
      ended = 'failed';
      this.logger.error(`Discussion ${a.taskId} failed: ${(e as Error).message}`);
      await this.note(a, `⚠️ The discussion stopped: ${(e as Error).message.slice(0, 200)}`);
    } finally {
      this.active.delete(a.taskId);
      const task = await this.prisma.task.findUnique({ where: { id: a.taskId }, select: { status: true } });
      if (task && !isTerminalStatus(task.status)) await this.tasks.setStatus(a.taskId, ended === 'failed' ? 'failed' : 'review', ended === 'failed' ? 'discussion stopped' : undefined);
    }
  }

  /** A system line in the chat (not said by anyone). */
  private async note(a: Active, text: string): Promise<void> {
    const session = await this.prisma.agentSession.findFirst({ where: { taskId: a.taskId }, orderBy: { startedAt: 'desc' }, select: { id: true } });
    if (!session) return;
    const seq = a.seq++;
    await this.prisma.agentEvent
      .create({ data: { agentSessionId: session.id, taskId: a.taskId, seq, kind: 'discussion', speaker: 'system', text, attachments: encodeAttachments(this.config, []) as string[] } })
      .catch((e) => this.logger.warn(`Could not store a note in ${a.taskId}: ${(e as Error).message}`));
    this.bus.publish({ type: 'agent-log', payload: { taskId: a.taskId, agentSessionId: session.id, kind: 'discussion', speaker: 'system', text, seq, ts: new Date().toISOString() } });
  }
}

export { stripMark };
