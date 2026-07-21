import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import {
  runAgent,
  addUsage,
  emptyUsage,
  type AgentEvent,
  type HookWiring,
  type ReportedStatus,
  type RunUsage,
  type SubagentDefinition,
} from '@lds/agent-runner';
import { resolveProvider, type AgentModelEnv, type Provider } from '@lds/shared';
import { LitellmService, defaultKind, routeName, stripSelfPrefix } from '../litellm/litellm.service';
import { AppConfigService } from '../config/app-config.service';
import { encodeAttachments } from '../prisma/agent-event-attachments';
import { PrismaService } from '../prisma/prisma.service';
import { AgentEventBus } from '../bus/agent-event-bus';
import { SettingsService } from '../settings/settings.service';
import { AgentRegistryService, type AgentDef } from '../agent-registry/agent-registry.service';
import { SkillsLearnedService } from '../agent-registry/skills-learned.service';
import { ProvidersService } from '../providers/providers.service';
import { McpService } from '../mcp/mcp.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { PreviewService } from '../preview/preview.service';
import { AgentExecutor, type AgentRunOutcome, type TaskRunContext } from './agent-executor';

/** Per-skill and total caps (chars) on skill content folded into the prompt. */
const SKILL_FILE_CAP = 16_000;
const SKILLS_TOTAL_CAP = 64_000;

/**
 * Reporting-resume: when a run ends without calling report_task_status, we
 * resume the same Claude session ONCE and force it to declare its outcome. The
 * agent still has full context (its commits, the branch it pushed, what's left),
 * so the report reflects reality — this is what turns a "done with empty fields"
 * or a misleading "stalled" into an authoritative terminal signal. Kept cheap: a
 * tiny turn cap and a hard timeout so a single missing report can't cost much.
 */
const REPORTING_RESUME_MAX_TURNS = 3;
const REPORTING_RESUME_TIMEOUT_MS = 90_000;
const REPORTING_RESUME_PROMPT =
  'You ended your run without calling report_task_status. That tool is the ONLY ' +
  "signal recorded as this task's outcome — the prose in your previous message is " +
  'NOT saved anywhere. Call report_task_status now, then stop:\n' +
  '- If the work is complete: status "done", a `summary` of what you did, and the ' +
  'files you changed in `files` (mention the branch/commit you pushed in the summary).\n' +
  '- If you were blocked, or ran out of steps mid-work: status "blocked" (or "failed") ' +
  'with the remaining work in `handoff`.\n' +
  '- If you were waiting for an answer or asked a question you need decided before you ' +
  'can continue: status "blocked", and put the EXACT question (with any options/context) ' +
  'in `handoff` — that question is routed to whoever can answer (the lead that created ' +
  'this task, or the user). Do not just wait; a question left in prose is lost.\n' +
  'Do not do any further work — just report your status accurately.';

/**
 * Human-facing text of a report: summary + the blocked `handoff` (what the agent
 * needs from a human). Folding handoff in here is what carries a blocked agent's
 * question into task.error → fan-in summaries → escalations; without it the
 * question would be silently dropped.
 */
function reportText(report: ReportedStatus): string | null {
  const summary = report.summary?.trim();
  const handoff = report.handoff?.trim();
  if (summary && handoff) return `${summary}\n\nNeeds from a human: ${handoff}`;
  return summary || handoff || null;
}

/**
 * Real executor: drives @lds/agent-runner for a task, persisting a transcript
 * (AgentEvent rows) and an AgentSession, and publishing every step to the event
 * bus for live streaming. The PreToolUse approval hook is wired via env so
 * dangerous tools block on human approval.
 */
@Injectable()
export class RealAgentExecutor extends AgentExecutor {
  private readonly logger = new Logger(RealAgentExecutor.name);
  /** AbortControllers for runs currently in flight, keyed by task id. */
  private readonly active = new Map<string, AbortController>();

  /** Abort the in-flight run for a task (used by cancel). */
  override cancel(taskId: string): void {
    this.active.get(taskId)?.abort();
  }

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly bus: AgentEventBus,
    private readonly settings: SettingsService,
    private readonly agents: AgentRegistryService,
    private readonly providers: ProvidersService,
    private readonly mcp: McpService,
    private readonly litellm: LitellmService,
    private readonly attachments: AttachmentsService,
    private readonly preview: PreviewService,
    private readonly skillsLearned: SkillsLearnedService,
  ) {
    super();
  }

  async run(ctx: TaskRunContext): Promise<AgentRunOutcome> {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: ctx.taskId } });
    const agentDef = task.agentName
      ? await this.agents.get(task.agentName).catch(() => null)
      : null;
    const defaultProvider = await this.settings.defaultProvider();

    // Setup that is the same across every failover attempt (provider-independent).
    const { githubToken } = await this.settings.workspaceConfig();
    const mcpServers = await this.mcp.resolveMany(agentDef?.mcp ?? [], { GITHUB_TOKEN: githubToken });
    const attachmentPaths = await this.attachments.paths(ctx.taskId).catch(() => []);
    // Which attachments belong to THIS message (inline thumbnails): the ones
    // explicitly sent, else — on the first run — all (uploaded with the opener).
    const messageAttachments = ctx.attachments?.length
      ? ctx.attachments
      : ctx.followUpPrompt
        ? []
        : attachmentPaths.map((p) => basename(p));
    // Agent cwd: the worktree root, or the configured subdir within it. The
    // worktree root stays the write boundary (passed separately to the runner).
    const workDir = await this.settings.workDir(ctx.worktreePath);
    // Orient every agent (lead AND delegated sub-agents share this cwd): its cwd
    // IS the project (a per-task worktree checkout), so none of them hunt for a
    // "main project" elsewhere or hedge about the location.
    const projectMap = await buildProjectMap(workDir);
    const orientation = buildOrientation(
      workDir,
      ctx.worktreePath,
      task.branch,
      this.config.workspaceShared,
      projectMap,
    );
    // Other registered agents become delegatable subagents (each on its own provider).
    const agents = await this.buildSubagents(task.agentName, defaultProvider, orientation);
    if (Object.keys(agents).length) {
      this.logger.log(`Task ${task.id} subagents: [${Object.keys(agents).join(', ')}]`);
    }
    const appendSystemPrompt = await this.buildInstructions(agentDef);

    // Resume the most recent session with a Claude session id on a follow-up
    // (first attempt only) — including one that ended `errored` by hitting the
    // step limit, so "continue" truly resumes the conversation (with full
    // context) rather than starting fresh.
    let resumeSessionId: string | undefined;
    if (ctx.followUpPrompt) {
      const last = await this.prisma.agentSession.findFirst({
        where: {
          taskId: ctx.taskId,
          status: { in: ['completed', 'errored'] },
          claudeSessionId: { not: null },
        },
        orderBy: { startedAt: 'desc' },
      });
      resumeSessionId = last?.claudeSessionId ?? undefined;
    }

    // Provider chain: the primary followed by declared fallbacks (existing, with
    // a model), deduped. On a provider-level failure we walk to the next.
    const chain = await this.resolveProviderChain(agentDef, defaultProvider, task.providerOverride);
    if (!chain.length) {
      throw new Error('No runnable provider: set a default model on the provider or pick one on the agent.');
    }
    if (chain.length > 1) {
      this.logger.log(`Task ${ctx.taskId} provider chain: [${chain.map((c) => c.provider.name).join(' → ')}]`);
    }

    // Referenced tasks' summaries, folded into the prompt so the agent considers
    // related work. Empty when the task has no references.
    const refContext = await this.buildReferencesContext(ctx.taskId);
    const common = {
      ctx,
      workDir,
      refContext,
      basePrompt: task.prompt,
      agentDef,
      mcpServers,
      agents,
      appendSystemPrompt: `${orientation}\n\n${appendSystemPrompt}`,
      attachmentPaths,
      messageAttachments,
    };
    let last: AgentRunOutcome = { reported: null, errored: true, timedOut: false };
    let note: string | undefined;
    for (let i = 0; i < chain.length; i++) {
      const { provider, model } = chain[i]!;
      const isLast = i === chain.length - 1;
      const r = await this.attempt({
        ...common,
        provider,
        model,
        resumeSessionId: i === 0 ? resumeSessionId : undefined,
        leadingNote: note,
      });
      last = r.outcome;
      // A clean finish (or a non-provider error) is final. Only a provider-level
      // failure with another provider left triggers failover.
      if (!r.failoverWorthy || isLast) return r.outcome;
      const next = chain[i + 1]!.provider.name;
      note = `↻ failing over from "${provider.name}" (${r.reason}) → "${next}"`;
      this.logger.warn(`Task ${ctx.taskId}: ${note}`);
    }
    return last;
  }

  /**
   * Build the ordered provider chain for a run: the agent's provider (or the
   * default) first, then its declared fallbacks. Missing providers or ones
   * without a resolvable model are skipped; duplicates are collapsed.
   */
  private async resolveProviderChain(
    agentDef: AgentDef | null,
    defaultProvider: string,
    override?: string | null,
  ): Promise<{ provider: Provider; model: string }[]> {
    // A per-task provider override (e.g. a channel's /model) wins as the primary.
    const primary = override?.trim() || agentDef?.provider || defaultProvider;
    const primaryName = primary?.trim();
    const names = [primary, ...(agentDef?.fallbackProviders ?? [])];
    const seen = new Set<string>();
    const chain: { provider: Provider; model: string }[] = [];
    for (const raw of names) {
      const name = (raw ?? '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const provider = await this.providers.get(name).catch(() => null);
      if (!provider) {
        this.logger.warn(`Provider "${name}" not found — skipping in chain`);
        continue;
      }
      // The agent's pinned model belongs to its PRIMARY provider only — a
      // fallback provider can't run another provider's model, so it falls back
      // to its own default model. A provider override also ignores the pin (the
      // pinned model is for the agent's own provider, not the overridden one).
      const pinned = !override && name === primaryName ? agentDef?.model : undefined;
      const model = (pinned || provider.model || '').trim();
      if (!model) {
        this.logger.warn(`Provider "${name}" has no model — skipping in chain`);
        continue;
      }
      chain.push({ provider, model });
    }
    return chain;
  }

  /**
   * One agent run on a single provider. Streams+persists the transcript and the
   * agent's reported status. Returns the outcome plus whether the failure (if
   * any) is a provider-level error worth failing over to the next provider.
   */
  private async attempt(opts: {
    ctx: TaskRunContext;
    workDir: string;
    refContext: string;
    basePrompt: string;
    agentDef: AgentDef | null;
    provider: Provider;
    model: string;
    mcpServers: Record<string, Record<string, unknown>>;
    agents: Record<string, SubagentDefinition>;
    appendSystemPrompt: string;
    attachmentPaths: string[];
    messageAttachments: string[];
    resumeSessionId?: string;
    leadingNote?: string;
  }): Promise<{ outcome: AgentRunOutcome; failoverWorthy: boolean; reason: string }> {
    const { ctx, agentDef, provider, model } = opts;
    // Prepend referenced-task context (if any) to the message the agent sees.
    const rawPrompt = ctx.followUpPrompt ?? opts.basePrompt;
    const prompt = opts.refContext ? `${opts.refContext}\n${rawPrompt}` : rawPrompt;
    const modelEnv = await this.resolveModelEnv(provider, model);
    this.logger.log(
      `Task ${ctx.taskId} → provider ${provider.name} (${model})` +
        (Object.keys(opts.mcpServers).length ? ` · mcp=[${Object.keys(opts.mcpServers).join(', ')}]` : ''),
    );

    const session = await this.prisma.agentSession.create({
      data: { taskId: ctx.taskId, status: 'running', provider: provider.name, model },
    });
    this.publishAgentStatus(ctx.taskId, session.id, 'running');

    // Structured completion: the agent declares its outcome via report_task_status
    // (authoritative), heartbeat() records liveness. Holder (not a bare `let`) so
    // its type survives the closure assignment under control-flow narrowing.
    const reported: { value: ReportedStatus | null } = { value: null };
    let timedOut = false;
    const onReportStatus = (report: ReportedStatus): void => {
      reported.value = report;
      this.prisma.agentSession
        .update({
          where: { id: session.id },
          data: { reportedStatus: report.status, reportedSummary: reportText(report) },
        })
        .catch((err) => this.logger.warn(`Failed to persist reported status: ${(err as Error).message}`));
    };
    const onHeartbeat = (): void => {
      this.prisma.agentSession
        .update({ where: { id: session.id }, data: { lastHeartbeatAt: new Date() } })
        .catch(() => undefined);
    };

    const hook: HookWiring = {
      scriptPath: this.config.hookScriptPath,
      approvalsUrl: this.config.approvalsApiUrl,
      approvalTimeoutSeconds: await this.settings.approvalTimeoutSeconds(),
      secret: this.config.hookSecret,
      taskId: ctx.taskId,
      agentSessionId: session.id,
      sharedDistPath: this.config.sharedDistPath,
    };

    let seq = 0;
    let writeChain: Promise<unknown> = Promise.resolve();
    let capturedSessionId: string | null = null;

    const onEvent = (event: AgentEvent): void => {
      if (event.kind === 'system') capturedSessionId = event.sessionId || capturedSessionId;
      const current = seq++;
      let attachments: string[] = event.kind === 'prompt' ? (event.attachments ?? []) : [];
      // Images a tool returned (e.g. an MCP browser screenshot) are saved as task
      // attachments so they render inline in the transcript + gallery.
      if (event.kind === 'tool_result' && event.images?.length) {
        const imgs = event.images;
        attachments = imgs.map((img, i) => `shot-${current}-${i}.${extForMedia(img.mediaType)}`);
        writeChain = writeChain.then(() =>
          Promise.all(
            imgs.map((img, i) =>
              this.attachments
                .writeImage(ctx.taskId, attachments[i]!, img.data)
                .catch((err) => this.logger.warn(`Failed to save screenshot: ${(err as Error).message}`)),
            ),
          ),
        );
      }
      const ts = new Date().toISOString();
      this.bus.publish({
        type: 'agent-log',
        payload: {
          taskId: ctx.taskId,
          agentSessionId: session.id,
          kind: event.kind,
          text: event.text,
          attachments,
          seq: current,
          ts,
        },
      });
      writeChain = writeChain.then(() =>
        this.prisma.agentEvent
          .create({
            data: {
              agentSessionId: session.id,
              taskId: ctx.taskId,
              seq: current,
              kind: event.kind,
              text: event.text,
              // Widened to `string` on sqlite (see agent-event-attachments.ts);
              // the app is compiled against the postgres-typed client (the
              // canonical, narrower shape — same tradeoff as PrismaModule's cast).
              attachments: encodeAttachments(this.config, attachments) as string[],
            },
          })
          .catch((err) => this.logger.warn(`Failed to persist event: ${(err as Error).message}`)),
      );
    };

    // On a fallback attempt, lead the transcript with why we failed over.
    if (opts.leadingNote) onEvent({ kind: 'stderr', text: opts.leadingNote });
    // Record the user's message so the transcript reads as a chat.
    onEvent({ kind: 'prompt', text: prompt, attachments: opts.messageAttachments });

    const abortController = new AbortController();
    // Abort any stale controller for this task before replacing it.
    this.active.get(ctx.taskId)?.abort();
    this.active.set(ctx.taskId, abortController);
    const timeoutMs = this.config.agentRunTimeoutMs;
    const timer = setTimeout(() => {
      onEvent({ kind: 'stderr', text: `agent run timed out after ${Math.round(timeoutMs / 1000)}s — aborting` });
      timedOut = true;
      abortController.abort();
    }, timeoutMs);

    try {
      const result = await runAgent(
        {
          prompt: withAttachments(prompt, opts.attachmentPaths),
          cwd: opts.workDir,
          workspaceRoot: ctx.worktreePath,
          modelEnv,
          providerLabel: provider.name,
          modelLabel: model,
          maxTurns: this.config.agentMaxTurns,
          resumeSessionId: opts.resumeSessionId,
          appendSystemPrompt: opts.appendSystemPrompt,
          allowedTools: agentDef?.allowedTools,
          // Block SendMessage so the lead delegates via the Task tool.
          disallowedTools: [...(agentDef?.disallowedTools ?? []), 'SendMessage'],
          mcpServers: opts.mcpServers,
          agents: opts.agents,
          settingsDir: join(this.config.agentDir, 'runs', ctx.taskId),
          skillsDir: join(this.config.agentDir, 'skills'),
          attachmentsDir: this.attachments.dir(ctx.taskId),
          abortController,
          hook,
          onReportStatus,
          onHeartbeat,
          onCreateSubtask: ctx.onCreateSubtask,
          onCheckSubtasks: ctx.onCheckSubtasks,
          onScheduleCheck: ctx.onScheduleCheck,
          onStartPreview: () => this.preview.getOrStart(ctx.taskId, opts.workDir),
          onProposeLearnedSkill: (input) =>
            this.skillsLearned.propose(ctx.taskId, session.id, input.name, input.content),
        },
        onEvent,
      );
      // The run this timer bounds is over — disarm it NOW, not in finally: the
      // reporting-resume below (own controller, own 90s cap) would otherwise
      // race it, and a late firing would stamp timedOut/abort onto a run that
      // actually completed. (finally still clears it on the throw paths.)
      clearTimeout(timer);
      await writeChain;

      const finalSessionId = result.sessionId ?? capturedSessionId;

      // The run ended without the authoritative report_task_status. Resume the
      // same session ONCE and force the agent to declare its outcome now, so a
      // task that actually finished (commit + push) records its real result
      // instead of landing as "done" with empty fields or a misleading "stalled".
      // This also covers the step-limit case: the resumed agent tells us whether
      // it finished (done) or genuinely ran out mid-work (blocked/failed), which
      // the worker then routes on — no change to the worker's branches.
      // Skipped on abort/timeout (orchestrator-driven stops) and on a provider
      // error we're about to fail over. Best-effort: sets reported.value via
      // onReportStatus when it works; on failure the salvage below still runs.
      // Usage is attributed to THIS session (its provider). Accumulate the main
      // run and — when it runs — the reporting-resume, so the extra turn's
      // tokens/cost aren't dropped from per-provider stats.
      let usage: RunUsage = result.usage;
      const willFailover = result.isError && isFailoverWorthy(result.result);
      // Boundary for the salvage below: events at seq >= this belong to the
      // reporting-resume turn, not the original run.
      const preResumeSeq = seq;
      if (!reported.value && !abortController.signal.aborted && !willFailover && finalSessionId) {
        const resumeUsage = await this.reportingResume({
          sessionId: finalSessionId,
          workDir: opts.workDir,
          worktreePath: ctx.worktreePath,
          settingsDir: join(this.config.agentDir, 'runs', ctx.taskId),
          modelEnv,
          provider,
          model,
          appendSystemPrompt: opts.appendSystemPrompt,
          allowedTools: opts.agentDef?.allowedTools,
          disallowedTools: opts.agentDef?.disallowedTools,
          mcpServers: opts.mcpServers,
          hook,
          onReportStatus,
          onHeartbeat,
          onEvent,
        });
        usage = addUsage(usage, resumeUsage);
        await writeChain;
      }

      // If report_task_status STILL wasn't called (the agent skipped it even on
      // the reporting resume), salvage a summary from its last message so the
      // task doesn't end with an empty summary. Clearly marked as auto-generated
      // — it is NOT an agent-attested outcome.
      let fallbackSummary: string | undefined;
      let finalText: string | undefined;
      if (!reported.value) {
        const last = await this.prisma.agentEvent
          .findFirst({
            // Bounded to the ORIGINAL run: the resume turn appends to the same
            // session with higher seq, and its reply ("Understood…") is a
            // response to our resume prompt — not the agent's own last word.
            where: { agentSessionId: session.id, kind: 'assistant', text: { not: '' }, seq: { lt: preResumeSeq } },
            orderBy: { seq: 'desc' },
            select: { text: true },
          })
          .catch(() => null);
        const text = last?.text?.trim();
        if (text) {
          // Raw last message — the implicit question/handoff the worker escalates.
          finalText = text.slice(0, 1000);
          fallbackSummary = `(auto-summary — agent did not call report_task_status)\n${finalText}`;
        }
      }

      await this.prisma.agentSession.update({
        where: { id: session.id },
        data: {
          status: result.isError ? 'errored' : 'completed',
          claudeSessionId: finalSessionId,
          endedAt: new Date(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          numTurns: usage.numTurns,
          costUsd: usage.costUsd,
          apiMs: usage.apiMs,
          ...(fallbackSummary ? { reportedSummary: fallbackSummary } : {}),
        },
      });
      this.publishAgentStatus(ctx.taskId, session.id, result.isError ? 'errored' : 'completed');

      // Fail over only on a provider-level error (not an abort/timeout, not a
      // clean run, and never once the agent has declared an outcome — that
      // report is authoritative and must not be discarded by a retry).
      const aborted = abortController.signal.aborted;
      const failoverWorthy =
        result.isError && !aborted && !reported.value && isFailoverWorthy(result.result);
      return {
        outcome: {
          reported: reported.value ? reported.value.status : null,
          reportedSummary: reported.value ? (reportText(reported.value) ?? undefined) : undefined,
          errored: result.isError,
          timedOut,
          maxTurns: result.maxTurnsExceeded,
          finalText,
        },
        failoverWorthy,
        reason: failoverWorthy ? shortReason(result.result) : '',
      };
    } catch (err) {
      // runAgent only rethrows for a genuine (non-abort) SDK/transport error.
      await writeChain.catch(() => undefined);
      await this.prisma.agentSession
        .update({
          where: { id: session.id },
          data: { status: 'errored', claudeSessionId: capturedSessionId, endedAt: new Date() },
        })
        .catch(() => undefined);
      this.publishAgentStatus(ctx.taskId, session.id, 'errored');
      const message = (err as Error).message;
      this.logger.warn(`Task ${ctx.taskId} run error on "${provider.name}": ${message}`);
      // A rethrow from runAgent means the SDK itself couldn't proceed on this
      // provider (transport/protocol/fatal) — inherently provider-level, so fail
      // over regardless of the exact message. Aborts (cancel/timeout) don't, and
      // neither does a run where the agent already declared an outcome.
      const aborted = abortController.signal.aborted;
      // Hitting the step limit surfaces as a thrown error; it's NOT a provider
      // failure — don't fail over (a fresh provider would restart from scratch).
      // Flag it so the worker can offer to continue instead.
      const maxTurns = /maximum number of turns/i.test(message);
      const failoverWorthy = !aborted && !reported.value && !maxTurns;
      return {
        outcome: {
          reported: reported.value ? reported.value.status : null,
          reportedSummary: reported.value?.summary,
          errored: true,
          timedOut,
          maxTurns,
        },
        failoverWorthy,
        reason: failoverWorthy ? shortReason(message) : '',
      };
    } finally {
      clearTimeout(timer);
      if (this.active.get(ctx.taskId) === abortController) this.active.delete(ctx.taskId);
    }
  }

  /**
   * Resume a just-finished Claude session ONCE to force a report_task_status the
   * agent skipped. Runs on the SAME provider/model/session (so it keeps full
   * context), with a tiny turn cap and a hard timeout so it stays cheap. Streams
   * through the caller's onEvent (the report call shows in the transcript) and
   * sets reported.value via the caller's onReportStatus. Best-effort — never
   * throws; on any failure the caller falls back to its salvage handling.
   *
   * Returns the reporting turn's own usage so the caller can attribute it to the
   * session (zeroed on failure / no result).
   */
  private async reportingResume(opts: {
    sessionId: string;
    workDir: string;
    worktreePath: string;
    settingsDir: string;
    modelEnv: AgentModelEnv;
    provider: Provider;
    model: string;
    appendSystemPrompt: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    mcpServers: Record<string, Record<string, unknown>>;
    hook: HookWiring;
    onReportStatus: (report: ReportedStatus) => void;
    onHeartbeat: () => void;
    onEvent: (event: AgentEvent) => void;
  }): Promise<RunUsage> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), REPORTING_RESUME_TIMEOUT_MS);
    // Surface as an orchestration note (stderr), not a user turn.
    opts.onEvent({
      kind: 'stderr',
      text: '↻ run ended without report_task_status — resuming once to record the outcome',
    });
    try {
      const r = await runAgent(
        {
          prompt: REPORTING_RESUME_PROMPT,
          cwd: opts.workDir,
          workspaceRoot: opts.worktreePath,
          modelEnv: opts.modelEnv,
          providerLabel: opts.provider.name,
          modelLabel: opts.model,
          maxTurns: REPORTING_RESUME_MAX_TURNS,
          resumeSessionId: opts.sessionId,
          appendSystemPrompt: opts.appendSystemPrompt,
          allowedTools: opts.allowedTools,
          disallowedTools: [...(opts.disallowedTools ?? []), 'SendMessage'],
          mcpServers: opts.mcpServers,
          settingsDir: opts.settingsDir,
          abortController,
          hook: opts.hook,
          onReportStatus: opts.onReportStatus,
          onHeartbeat: opts.onHeartbeat,
        },
        opts.onEvent,
      );
      return r.usage;
    } catch (err) {
      this.logger.warn(
        `Reporting-resume failed for session ${opts.sessionId}: ${(err as Error).message}`,
      );
      return emptyUsage();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Map a provider + chosen model to the agent's Anthropic env.
   *  - OpenAI-native providers are proxied through LiteLLM (registered as
   *    `<name>/*`): the agent talks Anthropic to litellm with the master key,
   *    and litellm forwards to OpenAI with the provider's key.
   *  - Providers already pointing at litellm (e.g. ollama-local) must present
   *    the master key too, since litellm enforces it on every request.
   */
  private async resolveModelEnv(provider: Provider, model: string): Promise<AgentModelEnv> {
    const masterKey = this.config.litellmMasterKey;

    // Everything runs through LiteLLM when it's configured: ensure an exact
    // `<provider>/<model>` route exists, then point the agent at litellm with
    // the master key. litellm forwards to the real upstream with its own key.
    if (masterKey) {
      // Gateway-verbatim provider: use `model` as-is, no route to register
      // (see LitellmService.servesVerbatim). Ollama falls through to a route.
      if (this.litellm.servesVerbatim(provider)) {
        return {
          ANTHROPIC_MODEL: stripSelfPrefix(provider.name, model),
          ANTHROPIC_BASE_URL: this.config.litellmBaseUrl,
          ANTHROPIC_AUTH_TOKEN: masterKey,
        };
      }
      await this.litellm.ensureRoute(provider.name, model, {
        kind: provider.kind || defaultKind(provider.baseUrl),
        apiBase: provider.baseUrl,
        apiKey: provider.secret ?? '',
        rpm: provider.rpm,
        tpm: provider.tpm,
      });
      return {
        ANTHROPIC_MODEL: routeName(provider.name, model),
        ANTHROPIC_BASE_URL: this.config.litellmBaseUrl,
        ANTHROPIC_AUTH_TOKEN: masterKey,
      };
    }

    // No litellm configured → talk to the provider directly (only works for
    // Anthropic-protocol endpoints).
    return resolveProvider({ ...provider, model });
  }

  /**
   * Build the "Related tasks" context block from a task's outgoing references —
   * each referenced task's title + its latest reported summary (fallback:
   * title + status). Prepended to the prompt so the agent considers related
   * work. Empty string when the task has no references.
   */
  private async buildReferencesContext(taskId: string): Promise<string> {
    const links = await this.prisma.taskLink.findMany({
      where: { fromTaskId: taskId },
      orderBy: { createdAt: 'asc' },
      include: {
        to: {
          select: {
            id: true,
            title: true,
            status: true,
            sessions: {
              where: { status: 'completed', reportedSummary: { not: null } },
              orderBy: { startedAt: 'desc' },
              take: 1,
              select: { reportedSummary: true },
            },
          },
        },
      },
    });
    if (!links.length) return '';
    const items = links.map((l) => {
      const t = l.to;
      const summary = t.sessions[0]?.reportedSummary ?? `${t.title} (${t.status})`;
      return `- [${t.id}] ${t.title}: ${summary}`;
    });
    return (
      `## Related tasks (for context)\n` +
      `These related tasks were referenced; consider their outcomes before implementing:\n` +
      `${items.join('\n')}\n`
    );
  }

  /**
   * Build the delegatable subagents for a run: every registered agent except
   * the lead, each carrying its own system prompt, tools, and `model` (its
   * LiteLLM route, so it runs on its own provider). Agents without a resolvable
   * model are skipped. Never throws — a bad agent just isn't offered.
   */
  private async buildSubagents(
    leadName: string | null,
    defaultProvider: string,
    orientation: string,
  ): Promise<Record<string, SubagentDefinition>> {
    const map: Record<string, SubagentDefinition> = {};
    const summaries = await this.agents.list().catch(() => []);
    for (const s of summaries) {
      if (s.name === leadName) continue;
      const def = await this.agents.get(s.name).catch(() => null);
      if (!def) continue;
      const model = await this.subagentModel(def, defaultProvider).catch(() => null);
      if (!model) continue;
      // Sub-agents share the lead's worktree/cwd — give them the same orientation
      // so a delegated agent knows its working directory is the project.
      map[s.name] = {
        description: def.description || s.name,
        prompt: `${orientation}\n\n${await this.buildInstructions(def)}`,
        model,
        ...(def.allowedTools?.length ? { tools: def.allowedTools } : {}),
      };
    }
    return map;
  }

  /** The model name a subagent runs on: its LiteLLM route, or the bare model. */
  private async subagentModel(def: AgentDef, defaultProvider: string): Promise<string | null> {
    const provider = await this.providers.get(def.provider ?? defaultProvider).catch(() => null);
    if (!provider) return null;
    const model = (def.model || provider.model || '').trim();
    if (!model) return null;
    if (this.config.litellmMasterKey) {
      if (this.litellm.servesVerbatim(provider)) return stripSelfPrefix(provider.name, model);
      await this.litellm.ensureRoute(provider.name, model, {
        kind: provider.kind || defaultKind(provider.baseUrl),
        apiBase: provider.baseUrl,
        apiKey: provider.secret ?? '',
        rpm: provider.rpm,
        tpm: provider.tpm,
      });
      return routeName(provider.name, model);
    }
    return model;
  }

  /**
   * Build the system-prompt append, top to bottom:
   *   1. global SOUL  (<agentDir>/SOUL.md — fleet charter, all agents)
   *   2. project SOUL (<workspace repo>/SOUL.md — project charter)
   *   3. the chosen agent's body (or the DB default instruction)
   *   4. skill files from <agentDir>/skills (all, or the subset the agent declares)
   */
  private async buildInstructions(agent: AgentDef | null): Promise<string> {
    const parts: string[] = [];

    // SOUL is always on, regardless of which agent/role runs.
    const globalSoul = (await this.readCached(join(this.config.agentDir, 'SOUL.md')))?.trim() || null;
    if (globalSoul) parts.push(globalSoul);
    const projectSoul = (await this.readCached(join(this.config.workspaceRepoPath, 'SOUL.md')))?.trim() || null;
    if (projectSoul) parts.push(projectSoul);
    if (globalSoul || projectSoul) {
      this.logger.log(`SOUL loaded (global=${!!globalSoul}, project=${!!projectSoul})`);
    }

    const base = (agent?.instructions || (await this.settings.agentInstructions())).trim();
    if (base) parts.push(base);

    const skillsDir = join(this.config.agentDir, 'skills');
    try {
      // Recursive so the core/ + learned/ split is picked up; match by basename
      // since agents reference skills by bare name (e.g. `nestjs`).
      let files = (await readdir(skillsDir, { recursive: true })).filter(
        (f) => f.endsWith('.md') && basename(f).toLowerCase() !== 'readme.md',
      );
      if (agent?.skills) {
        const want = new Set(agent.skills.map((s) => (s.endsWith('.md') ? s : `${s}.md`)));
        // Learned skills are fleet-wide observations, created at runtime — they
        // can't appear in a static `skills:` list, so always load them. Core and
        // other declared skills stay opt-in via `want`.
        const isLearned = (f: string) => f.split(/[\\/]/).includes('learned');
        files = files.filter((f) => isLearned(f) || want.has(basename(f)));
      }
      files.sort();

      if (this.config.skillsLazy) {
        // Read-on-demand: inject only a short index (name + description + path).
        // Keeps the always-present guidance tiny; the agent reads the full file
        // when it's about to do related work.
        const index: string[] = [];
        for (const file of files) {
          const raw = (await this.readCached(join(skillsDir, file))) ?? '';
          const name = basename(file).replace(/\.md$/, '');
          const desc = frontmatterField(raw, 'description') || firstProseLine(raw) || '(no description)';
          index.push(`- **${name}** — ${desc}\n  full guidance: read \`${join(skillsDir, file)}\``);
        }
        if (index.length) {
          parts.push(
            `# Skills (read-on-demand)\nThese skills apply to you. Each line is a summary; **read ` +
              `the referenced file for the full conventions before doing related work** (they are ` +
              `plain files you can open with the Read tool).\n${index.join('\n')}`,
          );
        }
      } else {
        // Full inline (SKILLS_LAZY=false): fold each skill's full text in, capped.
        let budget = SKILLS_TOTAL_CAP;
        for (const file of files) {
          if (budget <= 0) {
            this.logger.warn(`Skills budget exhausted — skipping ${file} and the rest`);
            break;
          }
          let content = ((await this.readCached(join(skillsDir, file))) ?? '').trim();
          if (!content) continue;
          const cap = Math.min(SKILL_FILE_CAP, budget);
          if (content.length > cap) {
            this.logger.warn(`Skill ${file} truncated to ${cap} chars (was ${content.length})`);
            content = `${content.slice(0, cap)}\n…[truncated]`;
          }
          budget -= content.length;
          parts.push(`# Skill: ${basename(file)}\n${content}`);
        }
      }
    } catch {
      // no skills directory — base instructions only
    }
    return parts.join('\n\n');
  }

  /**
   * Read a file, served from an in-memory cache keyed by mtime. The same SOUL
   * and skill files are read up to ~8× per run (the lead plus each subagent's
   * instructions are built every run) and change rarely, so this drops the
   * repeated read+decode while staying live to edits — an mtime bump re-reads,
   * and new `learned/` skills are still discovered by the (uncached) readdir.
   * Returns null when the file is missing.
   */
  private readonly fileCache = new Map<string, { mtimeMs: number; content: string }>();

  private async readCached(path: string): Promise<string | null> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      this.fileCache.delete(path);
      return null;
    }
    const hit = this.fileCache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.content;
    const content = await readFile(path, 'utf8');
    this.fileCache.set(path, { mtimeMs, content });
    return content;
  }

  private publishAgentStatus(
    taskId: string,
    agentSessionId: string,
    status: 'running' | 'completed' | 'errored',
  ): void {
    this.bus.publish({
      type: 'agent-status',
      payload: { taskId, agentSessionId, status, ts: new Date().toISOString() },
    });
  }
}

/**
 * A short orientation block prepended to every agent's system prompt so it knows
 * its working directory IS the project — a per-task git worktree (isolated
 * checkout of the repo) — and doesn't go looking for a "main project" elsewhere.
 */
function buildOrientation(
  workDir: string,
  worktreeRoot: string,
  branch: string | null,
  shared = false,
  projectMap = '',
): string {
  const kind = shared
    ? 'the project repository (the shared main working directory)'
    : 'a dedicated git worktree (an isolated checkout of the project repository) created for this task';
  const lines = [
    '## Your workspace',
    `Your current working directory **is the project** — ${kind}:`,
    `- working directory: \`${workDir}\``,
  ];
  if (workDir !== worktreeRoot) {
    lines.push(`- repository root: \`${worktreeRoot}\` — you may read/write anywhere within it`);
  }
  if (branch) lines.push(`- branch: \`${branch}\``);
  lines.push(
    'The code here IS the project; do not look elsewhere for a "main" project or a',
    'parent directory. The repo is already checked out — run git from here as usual.',
    'Use paths relative to this directory. To list a directory, use a shell command',
    '(`ls`, `git ls-files`) — the file-reader tool reads files, not directories.',
    'Do NOT start your own dev server (`next dev`/`vite`/`npm run dev`): the workspace is',
    'shared and ports 3200–3203 are reserved for the orchestrator\'s preview — a server you',
    'launch collides with it and corrupts the `.next` build cache. Use `preview_worktree` to',
    'render a page if you have it; otherwise report and let the lead preview.',
  );
  if (projectMap) {
    lines.push(
      '',
      '## Project map',
      "The project's files (git-tracked) — use this instead of scanning to find things:",
      '```',
      projectMap,
      '```',
    );
  }
  return lines.join('\n');
}

/**
 * A compact map of the project's git-tracked files, injected into orientation so
 * an agent doesn't burn turns discovering structure. `.gitignore` already keeps
 * node_modules/build output out. Lists files when few; summarizes per top-level
 * directory when many. Best-effort — returns '' on any error.
 */
async function buildProjectMap(cwd: string): Promise<string> {
  const pexec = promisify(execFile);
  try {
    const { stdout } = await pexec('git', ['ls-files'], {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    });
    const files = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!files.length) return '';
    if (files.length <= 150) return files.sort().join('\n');

    // Too many to list — summarize: root files + per-top-level-dir counts.
    const rootFiles: string[] = [];
    const dirs = new Map<string, number>();
    for (const f of files) {
      const slash = f.indexOf('/');
      if (slash === -1) rootFiles.push(f);
      else {
        const dir = f.slice(0, slash);
        dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
      }
    }
    const dirLines = [...dirs.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dir, n]) => `${dir}/ (${n} files)`);
    return [...rootFiles.sort(), ...dirLines].join('\n');
  } catch {
    return '';
  }
}

/**
 * Provider-level failure patterns worth failing over to the next provider:
 * transport/connection, HTTP 4xx/5xx from the endpoint, rate limits, auth, and
 * model/tool-capability errors (e.g. a local model that can't emit tool calls).
 * Deliberately excludes aborts/timeouts (handled separately) and clean runs.
 */
// Keyed off reason phrases and status-codes-in-context — NOT bare digits, which
// match a stray "500"/"403" in a file path / diff / echoed model output and
// trigger a spurious failover. The catch-path already fails over on any non-abort
// throw, so this only needs to catch provider errors that arrive as a *result*.
const FAILOVER_PATTERNS: readonly RegExp[] = [
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EPIPE/i,
  /socket hang up|fetch failed|network error|connection (error|closed|refused)/i,
  /rate.?limit|too many requests|overloaded|capacity|temporarily unavailable/i,
  /internal server error|bad gateway|service unavailable|gateway timeout/i,
  /unauthorized|forbidden|authentication|invalid.*(api.?key|token)/i,
  // A status code only when qualified by a status keyword (HTTP/status/code/error).
  /\b(?:http|status(?:\s*code)?|code|error)\b[^0-9a-z]{0,8}(?:401|403|404|408|409|429|5\d\d)\b/i,
  /model.*(not found|not exist|unavailable|does not support)|no endpoints|unsupported model|invalid model/i,
  /does not support tools|tool use is not supported|function calling is not/i,
];

function isFailoverWorthy(message: string): boolean {
  if (!message) return false;
  // Abort/timeout are orchestrator-driven stops, not provider failures.
  if (/\baborted\b|timed out/i.test(message)) return false;
  return FAILOVER_PATTERNS.some((re) => re.test(message));
}

function shortReason(message: string): string {
  const m = (message || 'provider error').replace(/\s+/g, ' ').trim();
  return m.length > 80 ? `${m.slice(0, 80)}…` : m;
}

/** File extension for an image media type (defaults to png). */
function extForMedia(mediaType: string): string {
  const sub = (mediaType.split('/')[1] || 'png').toLowerCase();
  if (sub === 'jpeg') return 'jpg';
  return ['png', 'jpg', 'webp', 'gif'].includes(sub) ? sub : 'png';
}

/** Extract a single-line YAML frontmatter field (e.g. `description`) if present. */
function frontmatterField(raw: string, field: string): string | null {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/** First non-empty, non-frontmatter, non-heading line — a fallback summary. */
function firstProseLine(raw: string): string | null {
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && !t.startsWith('---')) return t.slice(0, 160);
  }
  return null;
}

/** Append attachment paths to the prompt so the agent views them via Read. */
function withAttachments(prompt: string, paths: string[]): string {
  if (!paths.length) return prompt;
  const list = paths.map((p) => `- ${p}`).join('\n');
  const lead = prompt.trim() ? prompt : 'Review the attached file(s).';
  return `${lead}\n\nAttached files (use the Read tool to view them):\n${list}`;
}
