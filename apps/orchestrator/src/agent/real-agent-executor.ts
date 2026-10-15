import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import {
  runtimeForProviderKind,
  addUsage,
  emptyUsage,
  type AdminToolsWiring,
  type CodexRunOptions,
  type InternalToolHandlers,
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
import { AgentRegistryService, isBuiltinAgent, type AgentDef } from '../agent-registry/agent-registry.service';
import { SkillsLearnedService } from '../agent-registry/skills-learned.service';
import { AgentCatalogService } from '../agent-registry/agent-catalog.service';
import { InternalMcpService } from '../internal-mcp/internal-mcp.service';
import { CodexService } from '../codex/codex.service';
import { codexImagesDir, listGeneratedImages } from './codex-images';
import { inlineBlock, readInlineFiles } from './inline-attachments';
import { extractDocument } from '../knowledge/extract';
import { WorkspaceService } from '../workspace/workspace.service';
import { ResourcesService } from '../resources/resources.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { stripMark } from '../discussion/discussion-core';
import { describeNow } from './clock';
import { QuestionsService } from '../questions/questions.service';
import { MediaService } from '../media/media.service';
import { isVideoName } from '../media/media-core';
import { AgentProposalsService } from '../agent-registry/agent-proposals.service';
import { PlatformAdminService } from '../agent-registry/platform-admin.service';
import { ProvidersService } from '../providers/providers.service';
import { McpService } from '../mcp/mcp.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { PreviewService } from '../preview/preview.service';
import { budgetExceeded, isIdleStuck } from './run-guards';
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
    private readonly catalog: AgentCatalogService,
    private readonly proposals: AgentProposalsService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly internalMcp: InternalMcpService,
    private readonly codex: CodexService,
    private readonly resources: ResourcesService,
    private readonly workspace: WorkspaceService,
    private readonly media: MediaService,
    private readonly questions: QuestionsService,
    private readonly knowledge: KnowledgeService,
  ) {
    super();
  }

  async run(ctx: TaskRunContext): Promise<AgentRunOutcome> {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: ctx.taskId } });
    // A discussion turn runs the named participant, not the task's own agent.
    const agentName = ctx.discussion?.agent ?? task.agentName;
    const agentDef = agentName
      ? await this.agents.get(agentName).catch(() => null)
      : null;
    const defaultProvider = await this.settings.defaultProvider();

    // Setup that is the same across every failover attempt (provider-independent).
    const { githubToken } = await this.settings.workspaceConfig();
    // A discussion participant only talks: none of the agent's own MCP servers (their tools could write somewhere).
    const mcpServers = ctx.discussion ? {} : await this.mcp.resolveMany(agentDef?.mcp ?? [], { GITHUB_TOKEN: githubToken });
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
    const chat = agentDef?.mode === 'chat' || Boolean(ctx.discussion);
    const workDir = chat ? ctx.worktreePath : await this.settings.workDir(ctx.worktreePath);
    // Orient every agent (lead AND delegated sub-agents share this cwd): its cwd
    // IS the project (a per-task worktree checkout), so none of them hunt for a
    // "main project" elsewhere or hedge about the location.
    const projectMap = chat ? '' : await buildProjectMap(workDir);
    const workspaceOn = !chat; // chat agents and discussion participants get the tools, not the prompt block
    const orientation =
      (chat ? buildChatOrientation(workDir) : buildOrientation(workDir, ctx.worktreePath, task.branch, this.config.workspaceShared, projectMap)) +
      (workspaceOn ? `\n\n${this.workspace.orientation()}` : '');
    // Other registered agents become delegatable subagents (each on its own provider);
    // a chat agent talks to the user directly and delegates to no one.
    const leadProvider = task.providerOverride ?? agentDef?.provider ?? defaultProvider;
    const { map: agents, roster } = chat ? { map: {}, roster: '' } : await this.buildSubagents(task.agentName, leadProvider, orientation);
    if (Object.keys(agents).length) {
      this.logger.log(`Task ${task.id} subagents: [${Object.keys(agents).join(', ')}]`);
    }
    // The workspace memory goes LAST so the static part of the prompt stays cacheable.
    const memory = workspaceOn ? await this.workspace.digest().catch(() => '') : '';
    const appendSystemPrompt = (await this.buildInstructions(agentDef)) + roster + (memory ? `\n\n${memory}` : '');

    // Resume the most recent session with a Claude session id on a follow-up
    // (first attempt only) — including one that ended `errored` by hitting the
    // step limit, so "continue" truly resumes the conversation (with full
    // context) rather than starting fresh.
    let resumeSessionId: string | undefined;
    if (ctx.followUpPrompt && !ctx.discussion) {
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
    const chain = await this.resolveProviderChain(agentDef, defaultProvider, ctx.discussion ? null : task.providerOverride);
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
      chat,
      attachmentPaths,
      messageAttachments,
    };
    const overBudget = await this.checkBudget(ctx.taskId);
    if (overBudget) {
      return { reported: 'blocked', reportedSummary: overBudget, errored: false, timedOut: false };
    }
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

  /** Callbacks behind the admin agent's catalog/propose tools (see AdminToolsWiring). */
  private adminTools(taskId: string, sessionId: string): AdminToolsWiring {
    return {
      catalogList: async () => {
        const items = await this.catalog.list();
        return items.length
          ? items.map((a) => `- ${a.name}: ${a.description}`).join('\n')
          : 'No templates are shipped with this release.';
      },
      catalogGet: async (name) => {
        try {
          return (await this.catalog.get(name)).content;
        } catch {
          return `No template named "${name}". Use catalog_list to see the available ones.`;
        }
      },
      agentsList: async () => {
        const [agents, skills] = await Promise.all([this.agents.list(), this.agents.listSkills()]);
        const a = agents.length ? agents.map((x) => `- ${x.name}: ${x.description}`).join('\n') : '(none)';
        return `Agents:\n${a}\n\nSkills: ${skills.length ? skills.join(', ') : '(none)'}`;
      },
      agentGet: async (name) => {
        try {
          return await readFile(join(this.config.agentDir, 'agents', `${basename(name)}.md`), 'utf8');
        } catch {
          return `No agent named "${name}". Use agents_list to see what exists.`;
        }
      },
      proposeAgent: (input) => this.proposals.proposeAgent(taskId, sessionId, input.name, input.content),
      proposeSkill: (input) => this.proposals.proposeSkill(taskId, sessionId, input.name, input.content),
      tasksList: (input) => this.platformAdmin.tasksList(input),
      proposeBatch: (input) => this.platformAdmin.proposeBatch(taskId, sessionId, input),
      proposeTask: (input) => this.platformAdmin.proposeTask(taskId, sessionId, input),
      adminHistory: (input) => this.platformAdmin.adminHistory(input),
      proposeSettings: (input) => this.platformAdmin.proposeSettings(taskId, sessionId, input),
      proposeUndo: (input) => this.platformAdmin.proposeUndo(taskId, sessionId, input),
      taskDiagnose: (id) => this.platformAdmin.taskDiagnose(id),
      usageReport: (input) => this.platformAdmin.usageReport(input),
      requestSecret: (input) => this.platformAdmin.requestSecret(taskId, sessionId, input),
      maintenanceReport: () => this.platformAdmin.maintenanceReport(),
      proposeCleanup: (input) => this.platformAdmin.proposeCleanup(taskId, sessionId, input),
      providersList: () => this.platformAdmin.providersList(),
      providerTest: (name) => this.platformAdmin.providerTest(name),
      proposeProvider: (input) => this.platformAdmin.proposeProvider(taskId, sessionId, input),
      packsList: () => this.platformAdmin.packsList(),
      proposePackInstall: (input) => this.platformAdmin.proposePackInstall(taskId, sessionId, input),
      proposeResource: (input) => this.platformAdmin.proposeResource(taskId, sessionId, input),
      channelsList: () => this.platformAdmin.channelsList(),
      proposeChannel: (input) => this.platformAdmin.proposeChannel(taskId, sessionId, input),
      schedulesList: () => this.platformAdmin.schedulesList(),
      proposeSchedule: (input) => this.platformAdmin.proposeSchedule(taskId, sessionId, input),
      accessStatus: () => this.platformAdmin.accessStatus(),
      updateStatus: () => this.platformAdmin.updateStatus(),
      proposeUpdate: (input) => this.platformAdmin.proposeUpdate(taskId, sessionId, input),
      proposeAllowedDomains: (input) => this.platformAdmin.proposeAllowedDomains(taskId, sessionId, input),
      proposeCloudflareAccess: (input) => this.platformAdmin.proposeCloudflareAccess(taskId, sessionId, input),
      proposeTaskAction: (input) => this.platformAdmin.proposeTaskAction(taskId, sessionId, input),
      proposeAgentDelete: (input) => this.platformAdmin.proposeAgentDelete(taskId, sessionId, input),
    };
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
  /** Soft token budgets (env, opt-in): returns the reason a run must not start, or null. */
  private async checkBudget(taskId: string): Promise<string | null> {
    const { budgetTokensPerTask: perTask, budgetTokensPerDay: perDay } = this.config;
    if (!perTask && !perDay) return null;
    const sum = async (where: { taskId?: string; startedAt?: { gte: Date } }): Promise<number> => {
      const a = await this.prisma.agentSession.aggregate({ where, _sum: { inputTokens: true, outputTokens: true } });
      return (a._sum.inputTokens ?? 0) + (a._sum.outputTokens ?? 0);
    };
    const task = perTask ? await sum({ taskId }) : 0;
    const day = perDay ? await sum({ startedAt: { gte: new Date(Date.now() - 24 * 3600_000) } }) : 0;
    return budgetExceeded({ task, day }, { perTask, perDay });
  }

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
    /** Conversational agent: no forced status-report resume. */
    chat?: boolean;
    attachmentPaths: string[];
    messageAttachments: string[];
    resumeSessionId?: string;
    leadingNote?: string;
  }): Promise<{ outcome: AgentRunOutcome; failoverWorthy: boolean; reason: string }> {
    const { ctx, agentDef, provider, model } = opts;
    // Prepend referenced-task context (if any) to the message the agent sees.
    const rawPrompt = ctx.followUpPrompt ?? opts.basePrompt;
    const prompt = opts.refContext ? `${opts.refContext}\n${rawPrompt}` : rawPrompt;
    const isCodex = provider.kind === 'codex';
    // Codex talks to OpenAI itself (ChatGPT login / API key) — no Anthropic env, no LiteLLM route.
    const modelEnv: AgentModelEnv = isCodex ? { ANTHROPIC_MODEL: model } : await this.resolveModelEnv(provider, model);
    // Session ids are runtime-specific; only resume a session this runtime created.
    const resumeSessionId = untagSessionId(opts.resumeSessionId, isCodex);
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
    const debugMode = await this.settings.debugMode();
    // The chat itself (what the human sent, what the agent finally answered) is
    // always kept; the intermediate process trace (thinking/tool calls/system
    // chatter) is only worth the DB weight when someone's actually debugging —
    // it still streams live either way, just isn't replayed on the next page load.
    const alwaysPersist = (event: AgentEvent) => event.kind === 'prompt' || event.kind === 'result' || event.kind === 'discussion' || (event.kind === 'assistant' && Boolean(event.attachments?.length));

    let lastEventAt = Date.now();
    let lastEventKind = 'system';
    let lastAssistantText = '';
    const onEvent = (raw: AgentEvent): void => {
      let event = raw;
      // A discussion turn: its final answer becomes a message BY that participant (and is handed back to the discussion).
      if (ctx.discussion && event.kind === 'assistant' && event.text.trim()) lastAssistantText = event.text;
      if (ctx.discussion && event.kind === 'result') {
        if (event.isError) {
          // an error ("API Error 401", "run aborted") is not something the participant SAID: keep it out of the conversation
          ctx.discussion.collect.error = event.text || 'the run failed';
          return;
        }
        ctx.discussion.collect.text = event.text.trim() || lastAssistantText;
        event = { kind: 'discussion', speaker: ctx.discussion.agent, text: stripMark(ctx.discussion.collect.text) };
      }
      lastEventAt = Date.now();
      lastEventKind = event.kind;
      if (event.kind === 'system') capturedSessionId = event.sessionId || capturedSessionId;
      const current = seq++;
      let attachments: string[] = event.kind === 'prompt' || event.kind === 'assistant' ? (event.attachments ?? []) : [];
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
          ...(event.kind === 'discussion' ? { speaker: event.speaker } : {}),
          seq: current,
          ts,
        },
      });
      if (!debugMode && !alwaysPersist(event)) return;
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
              speaker: event.kind === 'discussion' ? event.speaker : null,
            },
          })
          .catch((err) => this.logger.warn(`Failed to persist event: ${(err as Error).message}`)),
      );
    };

    // On a fallback attempt, lead the transcript with why we failed over.
    if (opts.leadingNote) onEvent({ kind: 'stderr', text: opts.leadingNote });
    // Record the user's message so the transcript reads as a chat.
    if (!ctx.discussion) onEvent({ kind: 'prompt', text: prompt, attachments: opts.messageAttachments });
    else if (ctx.discussion.opening) onEvent({ kind: 'prompt', text: ctx.discussion.opening.text, attachments: ctx.discussion.opening.attachments });

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
    // No-progress watchdog: a run that goes silent (stuck provider stream, hung model call) is
    // aborted long before the overall ceiling. Waiting on a human or a running tool is not "stuck".
    const idleMs = this.config.agentIdleTimeoutMs;
    const idleTimer =
      idleMs > 0
        ? setInterval(() => {
            if (!isIdleStuck({ now: Date.now(), lastEventAt, lastEventKind, approvalsPending: false, idleMs })) return;
            void this.prisma.approvalRequest
              .count({ where: { taskId: ctx.taskId, status: 'pending' } })
              .then((pending) => {
                if (pending > 0 || !isIdleStuck({ now: Date.now(), lastEventAt, lastEventKind, approvalsPending: false, idleMs })) return;
                onEvent({ kind: 'stderr', text: `agent made no progress for ${Math.round(idleMs / 1000)}s — aborting (AGENT_IDLE_TIMEOUT_MS)` });
                timedOut = true;
                abortController.abort();
              })
              .catch(() => undefined);
          }, Math.min(15_000, Math.max(1_000, Math.floor(idleMs / 4))))
        : null;
    idleTimer?.unref?.();

    // Folders an agent may hand to show_images / look_at / workspace_save besides the library: its worktree, and (Codex) the pictures it generated.
    const generatedDir = codexImagesDir(this.config.agentDir, ctx.taskId);
    const mediaRoots = [ctx.worktreePath, generatedDir];
    // Internal control-plane tools: in-process for Claude, over HTTP MCP for Codex (same handlers).
    const toolHandlers: InternalToolHandlers = {
      onReportStatus,
      onHeartbeat,
      onCreateSubtask: ctx.onCreateSubtask,
      onCheckSubtasks: ctx.onCheckSubtasks,
      onCompleteSubtask: ctx.onCompleteSubtask,
      onScheduleCheck: ctx.onScheduleCheck,
      kb: {
        list: () => this.knowledge.listReport(agentDef?.name ?? null),
        search: (input) => this.knowledge.searchReport(input, agentDef?.name ?? null),
        read: (input) => this.knowledge.readReport(input, agentDef?.name ?? null),
        ...(ctx.discussion ? {} : { add: (input: { kb: string; title: string; text: string; source?: string }) => this.knowledge.addReport(input, agentDef?.name ?? null) }),
      },
      workspace: {
        info: () => this.workspace.info(),
        files: (input) => this.workspace.files(input),
        ...(ctx.discussion
          ? {}
          : {
              note: (input: { kind: string; text: string; resolves?: string }) => this.workspace.note(input, agentDef?.name),
              save: (input: { path: string; content?: string; from?: string; note?: string }) =>
                this.workspace.save(input, mediaRoots, async (dest) => {
                  // the result shows up in THIS task's attachments (gallery, chat, channels) as a link to the workspace file — no copy
                  const name = await this.attachments.link(ctx.taskId, dest);
                  if (/\.(png|jpe?g|webp|gif)$/i.test(name)) onEvent({ kind: 'assistant', text: '', attachments: [name] });
                  return `It is listed in the task's attachments as "${name}" (the person sees it there — no need to copy it).`;
                }),
            }),
      },
      // An agent with no file reader of its own (the admin, a read-restricted agent) reads attachments / workspace / library files through this.
      onReadDocument:
        !ctx.discussion && (agentDef?.mode === 'chat' || (agentDef?.allowedTools?.length && !agentDef.allowedTools.includes('Read')))
          ? async ({ path, from }) => {
              const file = path.startsWith('/') ? await this.media.safePath(path, mediaRoots) : (await this.attachments.filePath(ctx.taskId, path)).path;
              const st = await stat(file);
              if (!st.isFile()) throw new Error('That is not a file.');
              if (st.size > 25 * 1024 * 1024) throw new Error(`That file is too large to read (${Math.round(st.size / 1048576)} MB; the limit is 25 MB).`);
              const text = await extractDocument(basename(file), await readFile(file));
              const start = Math.max(0, Math.floor(from ?? 0));
              const part = text.slice(start, start + READ_DOCUMENT_CHARS);
              if (!part && start > 0) return `(end of the file — it has ${text.length} characters)`;
              const rest = text.length - start - part.length;
              return `${part}${rest > 0 ? `\n\n[… ${rest} more characters — call read_document again with from=${start + part.length}]` : ''}`;
            }
          : undefined,
      onCurrentTime: (input) => describeNow(new Date(), input.timezone),
      onShowImages: async (input) => {
        const paths = [...new Set(input.paths)].slice(0, 10);
        if (!paths.length) throw new Error('show_images needs at least one image path.');
        const names: string[] = [];
        const skipped: string[] = [];
        for (const p of paths) {
          try {
            const real = await this.media.safePath(p, mediaRoots);
            // already one of this task's attachments → just reference it; otherwise copy it in
            const own = await realpath(this.attachments.dir(ctx.taskId)).catch(() => this.attachments.dir(ctx.taskId));
            const name = dirname(real) === own ? basename(real) : await this.attachments.adopt(ctx.taskId, real);
            if (!names.includes(name)) names.push(name);
          } catch (e) {
            skipped.push(`${basename(p)} (${(e as Error).message.slice(0, 80)})`);
          }
        }
        if (!names.length) throw new Error(`None of the pictures could be shown: ${skipped.join('; ')}`);
        onEvent({ kind: 'assistant', text: (input.caption ?? '').trim(), attachments: names });
        return `Shown ${names.length} picture(s) to the user${names.length > 1 ? ' as an album' : ''}.${skipped.length ? ` Skipped: ${skipped.join('; ')}` : ''}`;
      },
      onAskUser: ctx.discussion ? undefined : async (input) => {
        const answer = await this.questions.ask(ctx.taskId, session.id, {
          ...input,
          // the picture shown with the question must be a real file of this task (never an arbitrary path)
          image: input.image ? await this.media.safePath(input.image, mediaRoots).catch(() => undefined) : undefined,
        });
        // what the person decided is team knowledge: it goes to workspace memory (decisions.md) by itself
        if (!opts.chat) void this.workspace.recordAnswer(input.question, answer);
        return answer;
      },
      onSearchResources: (input) => this.resources.searchReport(input, agentDef?.name),
      onLookAt: (input) => this.media.lookAt(input.path, input.question, mediaRoots, input, { provider: provider.name, model }),
      onVideoDigest: (input) => this.media.videoDigest(input.path, mediaRoots, input),
      onStartPreview: ctx.discussion ? undefined : () => this.preview.getOrStart(ctx.taskId, opts.workDir),
      onProposeLearnedSkill: ctx.discussion ? undefined : (input) => this.skillsLearned.propose(ctx.taskId, session.id, input.name, input.content),
      // Agent-management tools: the built-in admin agent only.
      admin: agentDef?.name === 'admin' && !ctx.discussion ? this.adminTools(ctx.taskId, session.id) : undefined,
    };
    const internalReg = isCodex ? this.internalMcp.register(toolHandlers) : null;
    const codexOpts: CodexRunOptions | undefined = isCodex
      ? {
          home: join(this.config.agentDir, 'runs', ctx.taskId, 'codex-home'),
          authHome: this.codex.authHome,
          apiKey: provider.authMode === 'api-key' ? (provider.secret ?? undefined) : undefined,
          bin: this.codex.bin,
          internalMcp: internalReg ? { url: internalReg.url, token: internalReg.token } : undefined,
        }
      : undefined;

    try {
      const result = await runtimeForProviderKind(provider.kind).run(
        {
          prompt: await this.promptWithAttachments(prompt, opts),
          cwd: opts.workDir,
          workspaceRoot: ctx.worktreePath,
          extraWriteRoots: ctx.discussion ? undefined : this.workspace.writeRoots,
          modelEnv,
          providerLabel: provider.name,
          modelLabel: model,
          maxTurns: this.config.agentMaxTurns,
          resumeSessionId,
          appendSystemPrompt: opts.appendSystemPrompt,
          // A discussion participant only talks (and may look things up): no editing, no shell, no delegation.
          allowedTools: ctx.discussion ? ['Read', 'Grep', 'Glob'] : agentDef?.allowedTools,
          // Block SendMessage so the lead delegates via the Task tool.
          disallowedTools: [...(agentDef?.disallowedTools ?? []), 'SendMessage', ...(ctx.discussion ? ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Task', 'Agent', 'WebFetch', 'WebSearch'] : [])],
          mcpServers: opts.mcpServers,
          agents: opts.agents,
          settingsDir: join(this.config.agentDir, 'runs', ctx.taskId),
          skillsDir: join(this.config.agentDir, 'skills'),
          attachmentsDir: this.attachments.dir(ctx.taskId),
          abortController,
          hook,
          codex: codexOpts,
          onProgress: () => {
            lastEventAt = Date.now();
          },
          ...toolHandlers,
        },
        onEvent,
      );
      // The run this timer bounds is over — disarm it NOW, not in finally: the
      // reporting-resume below (own controller, own 90s cap) would otherwise
      // race it, and a late firing would stamp timedOut/abort onto a run that
      // actually completed. (finally still clears it on the throw paths.)
      clearTimeout(timer);
      if (idleTimer) clearInterval(idleTimer);
      if (ctx.discussion && !ctx.discussion.collect.text.trim() && !ctx.discussion.collect.error && lastAssistantText.trim()) onEvent({ kind: 'result', text: lastAssistantText, isError: false, numTurns: 0, costUsd: 0 });
      // Codex generates pictures into its own sandbox folder: hand them to the person (attachments + chat) without asking the agent to copy them.
      if (isCodex && !ctx.discussion) await this.collectGeneratedImages(ctx.taskId, generatedDir, onEvent).catch((e) => this.logger.warn(`collecting generated images failed: ${(e as Error).message}`));
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
      if (!opts.chat && !reported.value && !abortController.signal.aborted && !willFailover && finalSessionId) {
        const resumeUsage = await this.reportingResume({
          sessionId: finalSessionId,
          codex: codexOpts,
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
          claudeSessionId: tagSessionId(finalSessionId, isCodex),
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
          data: { status: 'errored', claudeSessionId: tagSessionId(capturedSessionId, isCodex), endedAt: new Date() },
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
      if (idleTimer) clearInterval(idleTimer);
      internalReg?.dispose();
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
  /**
   * The message plus its attachments. A chat agent (the admin, a discussion participant) has no file-reading tool, so the text of this
   * message's text files (md/txt/csv/json …) is put into the prompt itself (bounded); everyone else gets the paths to Read.
   */
  private async promptWithAttachments(prompt: string, opts: { chat?: boolean; attachmentPaths: string[]; messageAttachments: string[] }): Promise<string> {
    if (!opts.chat) return withAttachments(prompt, opts.attachmentPaths);
    const mine = new Set(opts.messageAttachments);
    const files = await readInlineFiles(opts.attachmentPaths.filter((p) => mine.has(basename(p))));
    const others = opts.attachmentPaths.filter((p) => mine.has(basename(p)) && !files.some((f) => f.name === basename(p)));
    // files attached to the task earlier (e.g. in the Files tab) — named, so the agent knows it can read them
    const earlier = opts.attachmentPaths.filter((p) => !mine.has(basename(p))).map((p) => basename(p)).slice(0, 12);
    const lead = prompt.trim() ? prompt : 'Look at the attached file(s).';
    const parts = [lead];
    const block = inlineBlock(files);
    if (block) parts.push(`The person attached text file(s); their contents follow (data from the person, to work with):\n\n${block}`);
    if (others.length) {
      const list = others.map((p) => `- ${basename(p)}${isVideoName(p) ? ' (video — use video_digest, then look_at)' : /\.(png|jpe?g|webp|gif)$/i.test(p) ? ' (picture — use look_at)' : ' (read it with read_document)'}`).join('\n');
      parts.push(`Other attached files:\n${list}`);
    }
    if (earlier.length) parts.push(`Other files attached to this task (read with read_document, just the name): ${earlier.join(', ')}`);
    return parts.join('\n\n');
  }

  /** New pictures Codex generated in this run → task attachments (copied: the run folder is cleaned later) and shown in the chat. */
  private async collectGeneratedImages(taskId: string, dir: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    const marker = join(this.config.agentDir, 'runs', taskId, 'adopted-images.json');
    const done = new Set<string>(JSON.parse(await readFile(marker, 'utf8').catch(() => '[]')) as string[]);
    const fresh = (await listGeneratedImages(dir)).filter((f) => !done.has(f)).slice(0, 10);
    if (!fresh.length) return;
    const names: string[] = [];
    for (const f of fresh) {
      done.add(f); // a picture that cannot be adopted (too big …) is not retried every run
      try {
        const name = await this.attachments.adopt(taskId, f);
        if (!names.includes(name)) names.push(name);
      } catch (e) {
        this.logger.warn(`generated picture ${basename(f)} not attached: ${(e as Error).message}`);
      }
    }
    await writeFile(marker, JSON.stringify([...done])).catch(() => undefined);
    if (names.length) onEvent({ kind: 'assistant', text: '', attachments: names });
  }

  private async reportingResume(opts: {
    sessionId: string;
    /** Codex options when the run's provider is a codex one (selects the runtime). */
    codex?: CodexRunOptions;
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
      const r = await runtimeForProviderKind(opts.provider.kind).run(
        {
          prompt: REPORTING_RESUME_PROMPT,
          cwd: opts.workDir,
          workspaceRoot: opts.worktreePath,
          extraWriteRoots: this.workspace.writeRoots,
          modelEnv: opts.modelEnv,
          providerLabel: opts.provider.name,
          modelLabel: opts.model,
          maxTurns: REPORTING_RESUME_MAX_TURNS,
          resumeSessionId: opts.sessionId,
          codex: opts.codex,
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
   *  - `authMode: 'oauth-token'` (CLI-minted subscription token) always
   *    bypasses LiteLLM — it can't forward one — and talks to the provider's
   *    native endpoint directly.
   *  - OpenAI-native providers are proxied through LiteLLM (registered as
   *    `<name>/*`): the agent talks Anthropic to litellm with the master key,
   *    and litellm forwards to OpenAI with the provider's key.
   *  - Providers already pointing at litellm (e.g. ollama-local) must present
   *    the master key too, since litellm enforces it on every request.
   */
  private async resolveModelEnv(provider: Provider, model: string): Promise<AgentModelEnv> {
    // CLI-minted OAuth/subscription token: LiteLLM can only forward a real
    // Anthropic API key, so this always bypasses it and talks to the family's
    // native endpoint directly — never registers a route.
    if (isOauthToken(provider)) {
      return resolveProvider({ ...provider, model });
    }

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
   *
   * Limitation: the SDK spawns one subprocess per run, sharing a single
   * connection (base URL + auth) between the lead and every subagent. A CLI
   * OAuth/subscription provider always bypasses LiteLLM (see resolveModelEnv),
   * so when `defaultProvider` is one, no subagent — regardless of its own
   * provider — can share that connection; skip delegation entirely for this
   * task rather than offer subagents that would fail to resolve at runtime.
   */
  private async buildSubagents(
    leadName: string | null,
    leadProvider: string,
    orientation: string,
  ): Promise<{ map: Record<string, SubagentDefinition>; roster: string }> {
    const map: Record<string, SubagentDefinition> = {};
    const others: { name: string; description: string; how: string }[] = [];
    // The connection the run uses is the LEAD's provider (its own, or the default): a subscription login there cannot be shared.
    const leadRow = await this.providers.get(leadProvider).catch(() => null);
    const leadIsOauth = Boolean(leadRow && isOauthToken(leadRow));
    if (leadIsOauth) {
      this.logger.debug(`Lead provider "${leadProvider}" is oauth-token — the Task tool is not offered for this task (agents are reached with create_subtask)`);
    }
    const summaries = await this.agents.list().catch(() => []);
    for (const s of summaries) {
      if (s.name === leadName || isBuiltinAgent(s.name)) continue; // built-ins aren't delegation targets
      const def = await this.agents.get(s.name).catch(() => null);
      if (!def) continue;
      const desc = (def.description || s.name).replace(/\s+/g, ' ').trim().slice(0, 120);
      const why = leadIsOauth ? 'the lead runs on a subscription login' : await this.whyNotSubagent(def, leadProvider);
      if (why) {
        others.push({ name: s.name, description: desc, how: `create_subtask {agent:"${s.name}"} only (${why})` });
        continue;
      }
      const model = await this.subagentModel(def, leadProvider).catch(() => null);
      if (!model) {
        others.push({ name: s.name, description: desc, how: `create_subtask {agent:"${s.name}"} only (no model set)` });
        continue;
      }
      // Sub-agents share the lead's worktree/cwd — give them the same orientation
      // so a delegated agent knows its working directory is the project.
      map[s.name] = {
        description: def.description || s.name,
        prompt: `${orientation}\n\n${await this.buildInstructions(def)}`,
        model,
        ...(def.allowedTools?.length ? { tools: def.allowedTools } : {}),
      };
      others.push({ name: s.name, description: desc, how: `Task tool, subagent_type "${s.name}" (or create_subtask)` });
    }
    // The lead is told how to reach each colleague: an agent on another runtime / a subscription login is NOT in the Task tool's list
    // ("Agent type … not found. Available agents: none") — it has to be started as a subtask.
    const roster = others.length
      ? `\n\n## Your colleagues\nReach each one the way it says — an agent marked "create_subtask only" is NOT available to the Task tool (do not try it there); start it with create_subtask {agent, prompt}. Names are exact.\n${others.map((o) => `- ${o.name}: ${o.description} — ${o.how}`).join('\n')}`
      : '';
    return { map, roster };
  }

  /** Why an agent cannot be a Task-tool subagent of this lead (null = it can). */
  private async whyNotSubagent(def: AgentDef, leadProvider: string): Promise<string | null> {
    const provider = await this.providers.get(def.provider ?? leadProvider).catch(() => null);
    if (!provider) return 'its provider is missing';
    if (provider.kind === 'codex') return 'it runs on Codex, another runtime';
    if (isOauthToken(provider)) return 'it uses a subscription login';
    return null;
  }

  /** The model name a subagent runs on: its LiteLLM route, or the bare model. */
  private async subagentModel(def: AgentDef, defaultProvider: string): Promise<string | null> {
    const provider = await this.providers.get(def.provider ?? defaultProvider).catch(() => null);
    if (!provider) return null;
    if (provider.kind === 'codex') {
      // A Claude lead can't delegate to a Codex-runtime agent via the SDK Task tool.
      this.logger.debug(`Subagent provider "${provider.name}" is codex — not offered as a subagent`);
      return null;
    }
    if (isOauthToken(provider)) {
      // Can't share a subagent slot on the lead's connection — see buildSubagents.
      this.logger.debug(`Subagent provider "${provider.name}" is oauth-token — not offered as a subagent`);
      return null;
    }
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
      } else {
        // Skills under core/admin/ document the admin agent's own toolbox and UI guide; they are opt-in
        // only (an agent with no `skills:` line otherwise inherits everything, which would hand every
        // agent instructions for tools it doesn't have).
        files = files.filter((f) => !f.split(/[\\/]/).includes('admin'));
      }
      files.sort();

      // Lazy mode hands the agent an index plus a path to `Read`; an agent that can't read files (e.g. the
      // tools-only admin) would never see the content, so its skills are always inlined.
      const canRead = !(agent?.disallowedTools ?? []).some((t) => /^read$/i.test(t));
      if (this.config.skillsLazy && canRead) {
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
    // The project's shared resource library (an agent that cannot read files — the tools-only admin — gets the tool instead).
    if (agent?.mode !== 'chat' && !(agent?.disallowedTools ?? []).some((t) => /^read$/i.test(t))) {
      const block = await this.resources.promptIndex(agent?.name);
      if (block) parts.push(block);
    }
    // Knowledge bases: one line per base this agent may search (the content stays out of the prompt).
    const kbBlock = await this.knowledge.promptBlock(agent?.name ?? null).catch(() => '');
    if (kbBlock) parts.push(kbBlock.trim());
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

/** A CLI-minted OAuth/subscription token — bypasses LiteLLM, see resolveModelEnv/subagentModel. */
function isOauthToken(provider: Pick<Provider, 'authMode'>): boolean {
  return provider.authMode === 'oauth-token';
}

/** Session ids are runtime-specific: Codex thread ids are stored with a `codex:` prefix. */
function tagSessionId(id: string | null, codex: boolean): string | null {
  return id && codex ? `codex:${id}` : id;
}
/** The raw id this runtime can resume, or undefined if the stored session belongs to the other runtime. */
function untagSessionId(stored: string | undefined, codex: boolean): string | undefined {
  if (!stored) return undefined;
  const isCodexId = stored.startsWith('codex:');
  if (codex) return isCodexId ? stored.slice('codex:'.length) : undefined;
  return isCodexId ? undefined : stored;
}

/** Orientation for a chat agent: no repo, no worktree — just a conversation. */
function buildChatOrientation(workDir: string): string {
  return [
    '## Your context',
    'You are in a live chat with the user — answer conversationally and keep replies focused.',
    `- working directory: \`${workDir}\` (the platform's agent configuration: agents/, skills/, catalog/)`,
    '- there is no project repository, git branch or dev server here; do not run builds or tests',
    '- you do NOT need to call report_task_status — your reply is the result of each turn',
  ].join('\n');
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
  /not signed in|failed to start \w+: spawn \S+ ENOENT/i,
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
const READ_DOCUMENT_CHARS = 12_000;

function withAttachments(prompt: string, paths: string[]): string {
  if (!paths.length) return prompt;
  const isVideo = (p: string) => isVideoName(p);
  const list = paths.map((p) => `- ${p}${isVideo(p) ? '  (video — use video_digest, then look_at if you need to see it)' : ''}`).join('\n');
  const lead = prompt.trim() ? prompt : 'Review the attached file(s).';
  const hasVideo = paths.some(isVideo);
  return `${lead}\n\nAttached files (use the Read tool to view photos, documents and text${hasVideo ? '; for a video call the video_digest tool — frames and what was said — and look_at to ask a question about what is shown' : ''}):\n${list}`;
}
