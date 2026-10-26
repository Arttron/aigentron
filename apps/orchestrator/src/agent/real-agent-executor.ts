import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  runtimeForProviderKind,
  addUsage,
  emptyUsage,
  type AdminToolsWiring,
  type AgentIsolation,
  type CodexRunOptions,
  type InternalToolHandlers,
  type AgentEvent,
  type HookWiring,
  type ReportedStatus,
  type RunUsage,
  type SessionTotals,
  type SubagentDefinition,
} from '@lds/agent-runner';
import { EXTEND_RUN_TOOL, PUSH_BRANCH_TOOL, isListedMarkdown, parseFrontmatter, resolveProvider, type AgentModelEnv, type Provider } from '@lds/shared';
import { LitellmService, routeName, routeParams, stripSelfPrefix } from '../litellm/litellm.service';
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
import { readDocumentText } from '../knowledge/extract';
import { WorkspaceService } from '../workspace/workspace.service';
import { ResearchMcpService } from '../research/research-mcp.service';
import { ResourcesService } from '../resources/resources.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { stripMark } from '../discussion/discussion-core';
import { describeNow } from './clock';
import { QuestionsService } from '../questions/questions.service';
import { MediaService } from '../media/media.service';
import { isImageName, isVideoName } from '../media/media-core';
import { AgentProposalsService } from '../agent-registry/agent-proposals.service';
import { PlatformAdminService } from '../agent-registry/platform-admin.service';
import { ProvidersService } from '../providers/providers.service';
import { McpService } from '../mcp/mcp.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { PreviewService } from '../preview/preview.service';
import { budgetExceeded, isIdleStuck, runExtension, runIsAlive } from './run-guards';
import { oomVictim, readMemInfo } from '../queue/capacity-gate';
import { isShowableImage, parseTaskRef, taskRef } from '../attachments/task-ref';
import { RunLimitsService } from '../settings/run-limits.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { assemblePromptLayers, withRunContext } from './prompt-layers';
import { AgentExecutor, type AgentRunOutcome, type TaskRunContext } from './agent-executor';
import { classifyProviderFailure, errorTextOf, isFailoverWorthy, reportText, shortReason, tagSessionId, untagSessionId } from './run-outcome';
import { ProviderCooldown } from './provider-cooldown';
import { resolveProviderChain } from './provider-chain';
import { accountRunUsage, addTotals, budgetTokens, emptyTotals, reportingResumeUsage, startOfLocalDay, totalsAfter } from './usage-accounting';
import { RunDeadline } from './run-watchdogs';
import { getTaskLiteOrThrow } from './task-lite';
import { AgentUserService } from './agent-user.service';
import { ProjectsService } from '../projects/projects.service';
import { extraWriteRootsFor, resolveWorkDir, type ProjectContext } from '../projects/project-context';
import { parsePushRefs } from '../projects/push-core';
import { GitHubService } from '../worktrees/github.service';
import { splitSubtaskReport } from '../tasks/subtask-report';
import { scopeAdminTools, scopePrompt, type AdminScope } from './admin-scope';
import { parsePinnedAgents } from '../projects/project-core';
import { projectFacts } from './project-orientation';
import { GIT_CREDENTIALS, type GitCredentialsProvider } from '../projects/git-credentials.port';
import type { Workspace } from '../workspace/workspace.service';

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

/** The Claude CLI's answer when the session it was asked to resume is not in its store. */
/** After the memory guard stopped a run it leaves the others alone this long (the stopped run's processes are still exiting). */
const GUARD_GRACE_MS = 20_000;
const SESSION_GONE = /No conversation found with session ID/i;

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
  /** Runs in flight for the memory guard: when each started and how to stop it (with the memory left, for the transcript). */
  private readonly guarded = new Map<string, { startedAt: number; stop: (availableMb: number) => void }>();
  private guardTimer: ReturnType<typeof setInterval> | null = null;
  /** when the guard last stopped a run: the memory it frees is not back yet, so it waits before stopping another */
  private lastGuardStopAt = 0;

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
    private readonly researchMcp: ResearchMcpService,
    private readonly media: MediaService,
    private readonly questions: QuestionsService,
    private readonly knowledge: KnowledgeService,
    private readonly agentUser: AgentUserService,
    private readonly projects: ProjectsService,
    private readonly github: GitHubService,
    @Inject(GIT_CREDENTIALS) private readonly credentials: GitCredentialsProvider,
    private readonly runLimits: RunLimitsService,
    private readonly moduleRef: ModuleRef,
  ) {
    super();
  }

  async run(ctx: TaskRunContext): Promise<AgentRunOutcome> {
    const task = await getTaskLiteOrThrow(this.prisma, ctx.taskId);
    // The task's project decides where the agent works, which folder its workspace tools use, what it may write to.
    const project = await this.projects.contextFor(task);
    const workspace = this.workspace.at(project.workspaceRoot, { briefFile: project.briefFile, briefTemplate: project.briefTemplate, project: project.isDefault ? null : { name: project.name, slug: project.slug } });
    // A discussion turn runs the named participant, not the task's own agent.
    const agentName = ctx.discussion?.agent ?? task.agentName;
    const agentDef = agentName
      ? await this.agents.get(agentName).catch(() => null)
      : null;
    const defaultProvider = await this.settings.defaultProvider();

    // Setup that is the same across every failover attempt (provider-independent).
    // Providers and MCP servers are shared by all projects; the one per-run credential is the GITHUB_TOKEN the shared
    // `github` server gets: the TASK'S PROJECT's token (the port), else the installation's legacy one, else whatever
    // the server's own config says (a `${GITHUB_TOKEN}` placeholder becomes empty).
    const githubToken = (await this.credentials.apiTokenFor?.(project.git).catch(() => null)) ?? (await this.settings.githubToken());
    // A discussion participant only talks: none of the agent's own MCP servers (their tools could write somewhere).
    const mcpServers = ctx.discussion ? {} : await this.mcp.resolveMany(agentDef?.mcp ?? [], { GITHUB_TOKEN: githubToken });
    // The built-in research server lives in this process and only serves runs that carry a bearer (S-04): give this run its own.
    const researchCfg = mcpServers['research'] as { url?: string; headers?: Record<string, string> } | undefined;
    if (researchCfg?.url) researchCfg.headers = { ...(researchCfg.headers ?? {}), Authorization: `Bearer ${this.researchMcp.register().token}` };
    const attachmentPaths = await this.attachments.paths(ctx.taskId).catch(() => []);
    const attachmentOriginals = await this.attachments.originalNames(ctx.taskId).catch(() => ({}) as Record<string, string>);
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
    const docs = !chat && project.kind !== 'code';
    const workDir = chat || docs ? ctx.worktreePath : await resolveWorkDir(ctx.worktreePath, project.repoSubdir, (m) => this.logger.warn(`[${project.slug}] ${m}`));
    // Orient every agent (lead AND delegated sub-agents share this cwd): its cwd
    // IS the project (a per-task worktree checkout), so none of them hunt for a
    // "main project" elsewhere or hedge about the location. The orientation is
    // static for a task (paths, branch) — it lives in the system append.
    const workspaceOn = !chat; // chat agents and discussion participants get the tools, not the prompt block
    const orientation =
      (chat ? buildChatOrientation(workDir) : docs ? buildDocsOrientation(workDir, project) : buildOrientation(workDir, ctx.worktreePath, task.branch, project.isolation === 'shared', project, !ctx.discussion && !!project.repoUrl)) +
      (workspaceOn ? `\n\n${workspace.orientation()}` : '');
    // What changes between runs (the project map, the workspace memory) goes into
    // the run's MESSAGE, never into the system append: a changed system block
    // throws away the prompt cache of the whole conversation (see prompt-layers.ts).
    const projectMap = chat || docs ? '' : await buildProjectMap(workDir);
    const memory = workspaceOn ? await workspace.digest().catch(() => '') : '';
    // The admin in the chat of a project (not the default one) is that project's assistant, not the platform's: its tools are narrowed (admin-scope.ts) and it is told so.
    const adminScope = agentDef?.name === 'admin' && !ctx.discussion ? await this.adminScopeFor(project) : null;
    const instructions = `${await this.buildInstructions(agentDef, project)}${adminScope ? `\n\n${scopePrompt(adminScope)}` : ''}`;
    // Other registered agents become delegatable subagents (each on its own provider);
    // a chat agent talks to the user directly and delegates to no one. The map
    // depends on the LEAD's provider (an agent without a provider of its own runs
    // on the lead's; a subscription lead cannot share its connection), so it is
    // built per attempt: after a failover the `Task` tool must not point at the
    // failed provider's routes (X-FO-7).
    const prepared = new Map<string, { agents: Record<string, SubagentDefinition>; systemAppend: string; runContext: string }>();
    const prepare = async (leadProvider: string) => {
      const hit = prepared.get(leadProvider);
      if (hit) return hit;
      const { map: agents, roster } = chat ? { map: {}, roster: '' } : await this.buildSubagents(task.agentName, leadProvider, orientation, project);
      if (Object.keys(agents).length) {
        this.logger.log(`Task ${task.id} subagents on ${leadProvider}: [${Object.keys(agents).join(', ')}]`);
      }
      const layers = assemblePromptLayers({ orientation, instructions, roster, projectMap, memory });
      const p = { agents, systemAppend: layers.systemAppend, runContext: layers.runContext };
      prepared.set(leadProvider, p);
      return p;
    };

    // Resume the most recent session with a Claude session id on a follow-up
    // (first attempt only) — including one that ended `errored` by hitting the
    // step limit, so "continue" truly resumes the conversation (with full
    // context) rather than starting fresh.
    let resumeSessionId: string | undefined;
    let resumedFrom: Date | undefined;
    const followUp = Boolean(ctx.followUpPrompt) && !ctx.discussion;
    if (followUp) {
      const last = await this.prisma.agentSession.findFirst({
        where: {
          taskId: ctx.taskId,
          status: { in: ['completed', 'errored'] },
          claudeSessionId: { not: null },
        },
        orderBy: { startedAt: 'desc' },
        select: { claudeSessionId: true, startedAt: true },
      });
      resumeSessionId = last?.claudeSessionId ?? undefined;
      resumedFrom = last?.startedAt;
    }

    // Provider chain: the primary followed by declared fallbacks (existing, with
    // a model), deduped. On a provider-level failure we walk to the next — except
    // on a follow-up (X-FO-1): the conversation lives with its provider, so a
    // failure there ends the run with the provider's error instead of handing
    // another provider just the follow-up text.
    const chain = await resolveProviderChain(
      { agent: agentDef, defaultProvider, override: ctx.discussion ? null : task.providerOverride, noFailover: followUp, cooling: (n) => this.cooldown.isCooling(n) },
      (name) => this.providers.get(name),
      (m) => this.logger.warn(m),
    );
    if (!chain.length) {
      throw new Error('No runnable provider: set a default model on the provider or pick one on the agent.');
    }
    if (chain.length > 1) {
      this.logger.log(`Task ${ctx.taskId} provider chain: [${chain.map((c) => c.provider.name).join(' → ')}]`);
    }

    // Referenced tasks' summaries, folded into the prompt so the agent considers
    // related work. Empty when the task has no references. A resumed session
    // already has the earlier references in its context: only the ones added
    // since the last run are repeated (E-05).
    const refContext = await this.buildReferencesContext(ctx.taskId, resumeSessionId ? resumedFrom : undefined);
    // S-01: when AGENT_RUN_AS_UID is set, hand the agent user what it writes (its home, the checkout, the
    // workspace, this task's attachments) and run the runtime as that user. Off = unchanged. Throws (→ the
    // task fails with the reason) when it is on but broken — never a silent run as root.
    const isolation = await this.agentUser.prepareRun({
      taskId: ctx.taskId,
      worktreePath: chat ? null : ctx.worktreePath,
      attachmentsDir: this.attachments.dir(ctx.taskId),
      repoPath: project.repoPath,
      shared: project.isolation === 'shared',
      workspaceDir: project.workspaceRoot,
    });
    const common = {
      ctx,
      project,
      workspace,
      workDir,
      refContext,
      basePrompt: task.prompt,
      agentDef,
      mcpServers,
      chat,
      attachmentPaths,
      attachmentOriginals,
      messageAttachments,
      isolation,
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
      const resume = i === 0 ? resumeSessionId : undefined;
      const { agents, systemAppend, runContext } = await prepare(provider.name);
      const run = (resumeId: string | undefined, refContext: string) =>
        this.attempt({
          ...common,
          refContext,
          provider,
          model,
          agents,
          appendSystemPrompt: systemAppend,
          runContext,
          resumeSessionId: resumeId,
          // A resumed session was already told about the task's files: list only the ones sent with THIS message (E-06).
          listedAttachments: resumeId && !chat ? attachmentPaths.filter((p) => messageAttachments.includes(basename(p))) : attachmentPaths,
          firstAttempt: i === 0,
          leadingNote: note,
        });
      let r = await run(resume, refContext);
      // The stored session cannot be resumed any more (the CLI's session store was reset — a rebuilt container, another data dir, a cleaned
      // home): start a fresh session on the same task instead of ending the follow-up with the SDK's error.
      if (resume && SESSION_GONE.test(r.outcome.errorText ?? r.reason ?? '')) {
        this.logger.warn(`Task ${ctx.taskId}: session ${resume} is gone — continuing in a fresh session`);
        const fresh = await this.buildReferencesContext(ctx.taskId, undefined);
        // The model's own memory is gone, the transcript is not: hand over the last exchanges (messages and answers, no tool noise).
        const past = await this.prisma.agentEvent.findMany({
          where: { taskId: ctx.taskId, kind: { in: ['prompt', 'result', 'subtask_report'] }, text: { not: '' } },
          orderBy: { createdAt: 'desc' },
          take: 12,
          select: { kind: true, text: true, speaker: true },
        });
        const history = past
          .reverse()
          .map((e) => `${e.kind === 'prompt' ? 'Person' : e.kind === 'subtask_report' ? `Subtask (${e.speaker ?? 'agent'})` : 'You'}: ${e.text.replace(/\s+/g, ' ').slice(0, 700)}`)
          .join('\n')
          .slice(-6000);
        const lost = `(The earlier session of this task could not be resumed. Its original request: ${task.prompt.slice(0, 1500)}\nThe conversation so far, oldest first:\n${history}\nContinue from here with the person's new message below.)\n`;
        r = await run(undefined, `${fresh ? `${fresh}\n` : ''}${lost}`);
      }
      last = r.outcome;
      // A used-up quota, a rate limit or a refused key: remember it, so the next runs start on a fallback right away.
      if (r.failoverWorthy) {
        const kind = classifyProviderFailure(r.outcome.errorText ?? r.reason);
        const ms = this.cooldown.mark(provider.name, kind);
        if (ms > 0) this.logger.warn(`Provider "${provider.name}" looks ${kind === 'quota' ? 'out of quota / plan' : kind === 'rate' ? 'rate limited' : 'unauthorised'} — runs prefer its fallbacks for ${Math.round(ms / 60_000)} min`);
      }
      // A clean finish (or a non-provider error) is final. Only a provider-level
      // failure with another provider left triggers failover.
      if (!r.failoverWorthy || isLast) return r.outcome;
      const next = chain[i + 1]!.provider.name;
      note = `↻ failing over from "${provider.name}" (${r.reason}) → "${next}"`;
      this.logger.warn(`Task ${ctx.taskId}: ${note}`);
    }
    return last;
  }

  /** The limits of the admin in the chat of a project that is not the default one (null = the platform admin, nothing narrowed). */
  private async adminScopeFor(project: ProjectContext): Promise<AdminScope | null> {
    if (project.isDefault) return null;
    const row = await this.projects.get(project.slug).catch(() => null);
    const pinned = parsePinnedAgents(row?.pinnedAgents);
    const agents = pinned.length ? pinned : project.defaultAgent ? [project.defaultAgent] : [];
    return {
      slug: project.slug,
      name: project.name,
      agents,
      canStartFor: (agent) => (pinned.length ? pinned.includes(agent) : agent !== 'admin'),
      owns: async (id) => (await this.prisma.task.findUnique({ where: { id }, select: { projectId: true } }).catch(() => null))?.projectId === project.id,
    };
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
      currentContext: () => this.platformAdmin.currentContext(taskId),
      usageReport: (input) => this.platformAdmin.usageReport(input),
      metricsReport: (input) => this.platformAdmin.metricsReport(input),
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
   * Soft token budgets (env, opt-in): returns the reason a run must not start,
   * or null. Counted tokens include cache reads/writes (X-COST-4) — what the
   * provider bills; the daily budget covers the current calendar day (server
   * time). Checked on every run, follow-ups included.
   */
  private async checkBudget(taskId: string): Promise<string | null> {
    const { budgetTokensPerTask: perTask, budgetTokensPerDay: perDay } = this.config;
    if (!perTask && !perDay) return null;
    const sum = async (where: { taskId?: string; startedAt?: { gte: Date } }): Promise<number> => {
      const a = await this.prisma.agentSession.aggregate({ where, _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true } });
      return budgetTokens(a._sum);
    };
    const task = perTask ? await sum({ taskId }) : 0;
    const day = perDay ? await sum({ startedAt: { gte: startOfLocalDay(new Date()) } }) : 0;
    return budgetExceeded({ task, day }, { perTask, perDay });
  }

  /**
   * What earlier rows of the same Claude session already account for (the SDK
   * reports running totals of the session — X-COST-1). Rows written before the
   * delta accounting hold running totals themselves, so the baseline may
   * overstate once; the delta is clamped at 0 (see usage-accounting.ts).
   */
  private async sessionBaseline(taskId: string, claudeSessionId: string | undefined): Promise<SessionTotals> {
    if (!claudeSessionId) return emptyTotals();
    const a = await this.prisma.agentSession
      .aggregate({ where: { taskId, claudeSessionId }, _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true, costUsd: true } })
      .catch(() => null);
    if (!a) return emptyTotals();
    return addTotals(emptyTotals(), {
      inputTokens: a._sum.inputTokens ?? 0,
      outputTokens: a._sum.outputTokens ?? 0,
      cacheReadTokens: a._sum.cacheReadTokens ?? 0,
      cacheCreationTokens: a._sum.cacheCreationTokens ?? 0,
      costUsd: a._sum.costUsd ?? 0,
    });
  }

  /**
   * The agent's last own message of a session (before `beforeSeq`): the implicit
   * question/handoff the worker escalates when there was no report (E-13).
   */
  private async salvageFinalText(agentSessionId: string, beforeSeq: number): Promise<string | undefined> {
    const last = await this.prisma.agentEvent
      .findFirst({
        where: { agentSessionId, kind: 'assistant', text: { not: '' }, seq: { lt: beforeSeq } },
        orderBy: { seq: 'desc' },
        select: { text: true },
      })
      .catch(() => null);
    const text = last?.text?.trim();
    return text ? text.slice(0, 1000) : undefined;
  }

  /** A full path stays as it is; a bare name is one of the task's attachments (what the prompt lists), resolved to its file. */
  private async attachmentOrPath(taskId: string, p: string, admin = false): Promise<string> {
    const v = String(p ?? '').trim();
    if (!v || v.startsWith('/') || v.includes('/')) return v;
    // The admin is asked about "this screenshot" from a task page: that task's file first, then the admin chat's own.
    const page = admin ? this.platformAdmin.pageTaskId(taskId) : null;
    if (page) {
      const there = await this.attachments.filePath(page, v).catch(() => null);
      if (there) return there.path;
    }
    return (await this.attachments.filePath(taskId, v)).path;
  }

  /** `push_branch`: validate, get a person's approval (fail-closed), then push the local branch with the project's credentials. */
  private async pushBranchFor(taskId: string, sessionId: string, project: ProjectContext, input: { branch: string; to?: string; reason?: string }): Promise<string> {
    const refs = parsePushRefs(input.branch, input.to);
    if (!refs.ok) return refs.message;
    const denied = await this.proposals.requireApproval(
      taskId,
      sessionId,
      PUSH_BRANCH_TOOL,
      { branch: input.branch, to: input.to, reason: input.reason },
      (i) => String(i.branch ?? '').trim() === refs.branch && (String(i.to ?? '').trim() || refs.branch) === refs.to,
    );
    if (denied) return denied.message;
    const r = await this.github.pushBranch(project, refs.branch, refs.to);
    return r.message;
  }

  /** `fetch_remote`: fetch the project's remote with the project's credentials (no approval — it only downloads). */
  private async fetchRemoteFor(project: ProjectContext, input: { branch?: string }): Promise<string> {
    const r = await this.github.fetchRemote(project, input.branch);
    return r.message;
  }

  /**
   * The message that starts this run, as the conversation shows it. Normally the person's words ("you>"); when it is the report of the lead's own subtasks it
   * is shown as what it is — one message from each subtask's agent — and the instructions to the lead are left out (the model still gets the whole text).
   */
  private async recordPrompt(taskId: string, raw: string, shown: string, attachments: string[], onEvent: (e: AgentEvent) => void): Promise<void> {
    const split = splitSubtaskReport(raw);
    if (split) {
      const kids = await this.prisma.task.findMany({ where: { parentId: taskId, id: { in: split.reports.map((r) => r.id) } }, select: { id: true, agentName: true } }).catch(() => []);
      const agentOf = new Map(kids.map((k) => [k.id, k.agentName]));
      const real = split.reports.filter((r) => agentOf.has(r.id)); // only this task's own subtasks count (the id in a text proves nothing)
      if (real.length) {
        for (const r of real) onEvent({ kind: 'subtask_report', speaker: agentOf.get(r.id) || 'agent', text: `**${r.title}** · ${r.status}\n\n${r.text}` });
        if (split.rest) onEvent({ kind: 'prompt', text: split.rest, attachments });
        return;
      }
    }
    onEvent({ kind: 'prompt', text: shown, attachments });
  }

  /** Providers that just failed with a used-up quota / rate limit / bad credentials (in memory — a hint for ordering, not state). */
  private readonly cooldown = new ProviderCooldown();

  /**
   * One agent run on a single provider. Streams+persists the transcript and the
   * agent's reported status. Returns the outcome plus whether the failure (if
   * any) is a provider-level error worth failing over to the next provider.
   */
  private async attempt(opts: {
    ctx: TaskRunContext;
    /** The task's project (paths, mode, write roots) and its workspace folder (the `workspace_*` tools, memory). */
    project: ProjectContext;
    workspace: Workspace;
    workDir: string;
    refContext: string;
    basePrompt: string;
    agentDef: AgentDef | null;
    provider: Provider;
    model: string;
    mcpServers: Record<string, Record<string, unknown>>;
    agents: Record<string, SubagentDefinition>;
    appendSystemPrompt: string;
    /** Project map + workspace memory for THIS run — goes into the agent's message, not the transcript (see prompt-layers.ts). */
    runContext: string;
    /** Conversational agent: no forced status-report resume. */
    chat?: boolean;
    /** Run the runtime as the separate agent OS user (S-01); null = as this process. */
    isolation: AgentIsolation | null;
    /** Every file of the task (chat agents read some of them inline). */
    attachmentPaths: string[];
    /** stored name → the name the person gave the file (shown to the agent next to the stored path) */
    attachmentOriginals: Record<string, string>;
    /** The ones the prompt lists for a working agent: all on a fresh run, only this message's on a resume (E-06). */
    listedAttachments: string[];
    messageAttachments: string[];
    resumeSessionId?: string;
    /** The first provider of the chain: the person's message is recorded once, not per failover attempt (E-34). */
    firstAttempt: boolean;
    leadingNote?: string;
  }): Promise<{ outcome: AgentRunOutcome; failoverWorthy: boolean; reason: string }> {
    const { ctx, agentDef, provider, model, workspace } = opts;
    // Prepend referenced-task context (if any) to the message the agent sees.
    const rawPrompt = ctx.followUpPrompt ?? opts.basePrompt;
    const prompt = opts.refContext ? `${opts.refContext}\n${rawPrompt}` : rawPrompt;
    const isCodex = provider.kind === 'codex';
    // Session ids are runtime-specific; only resume a session this runtime created.
    const resumeSessionId = untagSessionId(opts.resumeSessionId, isCodex);
    // What earlier runs of this Claude session already accounted for (X-COST-1).
    const baseline = isCodex ? emptyTotals() : await this.sessionBaseline(ctx.taskId, resumeSessionId);
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
    let memoryStopped = false;
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
    // The chat itself (what the human sent, what the agent said and finally answered — an agent's «see the answer above» must point at something that
    // survives a page reload) is always kept; the intermediate process trace (thinking/tool calls/system
    // chatter) is only worth the DB weight when someone's actually debugging —
    // it still streams live either way, just isn't replayed on the next page load.
    const alwaysPersist = (event: AgentEvent) => event.kind === 'prompt' || event.kind === 'result' || event.kind === 'discussion' || event.kind === 'subtask_report' || (event.kind === 'assistant' && (Boolean(event.attachments?.length) || Boolean(event.text.trim())));

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
      // stderr (CLI retries, our own notes) is not progress of the agent: it must not keep the idle watchdog quiet (X-RUN-2).
      if (event.kind !== 'stderr') {
        lastEventAt = Date.now();
        lastEventKind = event.kind;
      }
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
          ...(event.kind === 'discussion' || event.kind === 'subtask_report' ? { speaker: event.speaker } : {}),
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
              speaker: event.kind === 'discussion' || event.kind === 'subtask_report' ? event.speaker : null,
            },
          })
          .catch((err) => this.logger.warn(`Failed to persist event: ${(err as Error).message}`)),
      );
    };

    // On a fallback attempt, lead the transcript with why we failed over.
    if (opts.leadingNote) onEvent({ kind: 'stderr', text: opts.leadingNote });
    // Record the user's message so the transcript reads as a chat — once per
    // run: a failover attempt re-sends the same message to the next provider,
    // which is not a second message from the person.
    if (opts.firstAttempt) {
      if (!ctx.discussion) await this.recordPrompt(ctx.taskId, rawPrompt, prompt, opts.messageAttachments, onEvent);
      else if (ctx.discussion.opening) onEvent({ kind: 'prompt', text: ctx.discussion.opening.text, attachments: ctx.discussion.opening.attachments });
    }

    const abortController = new AbortController();
    // Abort any stale controller for this task before replacing it.
    this.active.get(ctx.taskId)?.abort();
    this.active.set(ctx.taskId, abortController);
    this.guarded.set(ctx.taskId, {
      startedAt: Date.now(),
      stop: (availableMb) => {
        memoryStopped = true;
        onEvent({ kind: 'stderr', text: `the machine is about to run out of memory (${Math.round(availableMb)} MB left) — this run is stopped before the system kills everything; press Continue when it is calmer` });
        abortController.abort();
      },
    });
    this.startMemoryGuard();
    // The hard ceiling counts ACTIVE time only (E-02): it is paused while the
    // agent waits for a human — an ask_user question (the handler below holds
    // it) or an approval in the PreToolUse hook (the bus events hold it).
    const limits = this.runLimits.get();
    const timeoutMs = limits.timeoutMin * 60_000;
    const maxMs = limits.maxMin * 60_000;
    const graceMs = limits.graceSec * 1000;
    let extendedNoted = false;
    const deadline: RunDeadline = new RunDeadline(
      timeoutMs,
      () => {
        const waited = Math.round(deadline.waitedMs / 1000);
        onEvent({ kind: 'stderr', text: `agent run timed out after ${Math.round(deadline.grantedMs / 1000)}s of active time${waited ? ` (plus ${waited}s waiting for a person)` : ''} — aborting` });
        timedOut = true;
        abortController.abort();
      },
      Date.now,
      // The window ran out. A run that is still producing output is given more time, up to the absolute ceiling; past it (or with no
      // automatic extension at all) a person is asked whether a run that is still working may go on. A quiet run just stops.
      async (): Promise<number> => {
        const state = { now: Date.now(), lastEventAt, lastEventKind, grantedMs: deadline.grantedMs, baseMs: timeoutMs, maxMs, graceMs, toolGraceMs: Math.max(graceMs, 10 * 60_000) };
        const more = runExtension(state);
        if (more > 0) {
          if (!extendedNoted) {
            extendedNoted = true;
            onEvent({ kind: 'stderr', text: `agent is still making progress after ${Math.round(timeoutMs / 1000)}s — its time is extended while it keeps working (up to ${limits.maxMin} min of active time)` });
          }
          return more;
        }
        if (!limits.askToExceed || !runIsAlive(state)) return 0;
        return this.askForMoreTime(ctx.taskId, session.id, Math.round(deadline.grantedMs / 60_000), limits.extraMin, onEvent);
      },
    );
    const heldApprovals = new Set<string>();
    const unsubscribeBus = this.bus.subscribe((e) => {
      if (e.type === 'approval-created' && e.payload.approval.taskId === ctx.taskId && !heldApprovals.has(e.payload.approval.id)) {
        heldApprovals.add(e.payload.approval.id);
        deadline.pause();
      } else if (e.type === 'approval-resolved' && heldApprovals.delete(e.payload.approvalId)) {
        deadline.resume();
      }
    });
    deadline.start();
    // No-progress watchdog: a run that goes silent (stuck provider stream, hung model call) is
    // aborted long before the overall ceiling. Waiting on a human or a running tool is not "stuck".
    const idleMs = limits.idleMin * 60_000;
    const idleTimer =
      idleMs > 0
        ? setInterval(() => {
            if (!isIdleStuck({ now: Date.now(), lastEventAt, lastEventKind, approvalsPending: deadline.paused, idleMs })) return;
            void this.prisma.approvalRequest
              .count({ where: { taskId: ctx.taskId, status: 'pending' } })
              .then((pending) => {
                if (pending > 0 || !isIdleStuck({ now: Date.now(), lastEventAt, lastEventKind, approvalsPending: deadline.paused, idleMs })) return;
                onEvent({ kind: 'stderr', text: `agent made no progress for ${Math.round(idleMs / 1000)}s — aborting (AGENT_IDLE_TIMEOUT_MS)` });
                timedOut = true;
                abortController.abort();
              })
              .catch(() => undefined);
          }, Math.min(15_000, Math.max(1_000, Math.floor(idleMs / 4))))
        : null;
    idleTimer?.unref?.();
    // Usage of a run that never reaches its result message (abort, timeout, transport error) — X-COST-3.
    let partial = emptyTotals();

    // Folders an agent may hand to show_images / look_at / workspace_save besides the library: its worktree, the folder of ITS project
    // (never another project's), and (Codex) the pictures it generated.
    const generatedDir = codexImagesDir(this.config.agentDir, ctx.taskId);
    // A chat agent's "worktree" is the whole agent dir (it holds runs/*/codex-home with sign-in tokens): never an allowed root for it.
    const mediaRoots = opts.chat ? [generatedDir, opts.project.workspaceRoot] : [ctx.worktreePath, generatedDir, opts.project.workspaceRoot];
    const kbScope = { projectId: opts.project.id };
    const isAdminChat = Boolean(opts.chat && agentDef?.name === 'admin');
    const adminScope = agentDef?.name === 'admin' && !ctx.discussion ? await this.adminScopeFor(opts.project) : null;
    // Which task's attachments the media tools may open: this task's only — except for the admin (every task's files, secret ones still excluded).
    const mediaScope = isAdminChat && !adminScope ? undefined : ctx.taskId; // the admin of a project's chat reads only its own task's files
    // What the agent may write to besides its task root: its project's folder (and, in shared mode, the checkout).
    const extraWriteRoots = ctx.discussion ? undefined : extraWriteRootsFor(opts.project, ctx.worktreePath);
    // Internal control-plane tools: in-process for Claude, over HTTP MCP for Codex (same handlers).
    const toolHandlers: InternalToolHandlers = {
      onReportStatus,
      onHeartbeat,
      // Publishing goes through the orchestrator (it holds the project's key/token; the agent holds none): a person approves each push.
      onFetchRemote: opts.project.kind === 'code' && opts.project.repoUrl && !ctx.discussion ? (input) => this.fetchRemoteFor(opts.project, input) : undefined,
      onPushBranch: opts.project.kind === 'code' && opts.project.repoUrl && !ctx.discussion ? (input) => this.pushBranchFor(ctx.taskId, session.id, opts.project, input) : undefined,
      onCreateSubtask: ctx.onCreateSubtask,
      // A LEAD (a top-level task — the one that may create subtasks) whose file says `createTasks: true` may start new tasks in a project (each approved by a person).
      onCreateTask: (opts.agentDef?.createTasks || opts.agentDef?.skills?.includes('task-splitting')) && ctx.onCreateSubtask && !ctx.discussion ? (input) => this.platformAdmin.createTaskForLead(ctx.taskId, session.id, input) : undefined,
      onCheckSubtasks: ctx.onCheckSubtasks,
      onCompleteSubtask: ctx.onCompleteSubtask,
      onScheduleCheck: ctx.onScheduleCheck,
      // Knowledge bases and resources a task may use: the global ones and its project's — never another project's.
      kb: {
        list: () => this.knowledge.listReport(agentDef?.name ?? null, kbScope),
        search: (input) => this.knowledge.searchReport(input, agentDef?.name ?? null, kbScope),
        read: (input) => this.knowledge.readReport(input, agentDef?.name ?? null, kbScope),
        ...(ctx.discussion ? {} : { add: (input: { kb: string; title: string; text: string; source?: string }) => this.knowledge.addReport(input, agentDef?.name ?? null, kbScope) }),
      },
      workspace: {
        info: () => workspace.info(),
        files: (input) => workspace.files(input),
        ...(ctx.discussion
          ? {}
          : {
              note: (input: { kind: string; text: string; resolves?: string }) => workspace.note(input, agentDef?.name),
              save: (input: { path: string; content?: string; from?: string; note?: string }) =>
                workspace.save(
                  input,
                  mediaRoots,
                  async (dest) => {
                    // the result shows up in THIS task's attachments (gallery, chat, channels) as a link to the workspace file — no copy
                    const name = await this.attachments.link(ctx.taskId, dest);
                    if (isImageName(name)) onEvent({ kind: 'assistant', text: '', attachments: [name] });
                    return `It is listed in the task's attachments as "${name}" (the person sees it there — no need to copy it).`;
                  },
                  this.attachments.dir(ctx.taskId), // only THIS task's attachments are a source (X-NEW-2)
                ),
            }),
      },
      // An agent with no file reader of its own (the admin, a read-restricted agent) reads attachments / workspace / library files through this.
      onReadDocument:
        !ctx.discussion && (agentDef?.mode === 'chat' || (agentDef?.allowedTools?.length && !agentDef.allowedTools.includes('Read')))
          ? async ({ path, from }) => {
              const file = path.startsWith('/') ? await this.media.safePath(path, mediaRoots, ctx.taskId) : (await this.attachments.filePath(ctx.taskId, path)).path;
              // 10 MB limit, extracted text cached by (path, mtime, size) — X-NEW-4
              const text = await readDocumentText(file);
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
            // a picture of one of THIS task's subtasks (`task:<id>/<name>`): shown from where it is — no copy, no link, nothing to clean up
            const foreign = parseTaskRef(p);
            if (foreign) {
              if (!(await this.isDescendantTask(foreign.taskId, ctx.taskId))) throw new Error('that is not a file of one of this task\'s subtasks');
              if (!isShowableImage(foreign.name)) throw new Error('that is not a picture (png, jpg, webp, gif) — name other files in the message instead');
              await this.attachments.filePath(foreign.taskId, foreign.name); // exists, and is a regular file
              const ref = taskRef(foreign.taskId, foreign.name);
              if (!names.includes(ref)) names.push(ref);
              continue;
            }
            const real = await this.media.safePath(await this.attachmentOrPath(ctx.taskId, p), mediaRoots, ctx.taskId);
            if (!isShowableImage(real)) throw new Error('that is not a picture (png, jpg, webp, gif)');
            // already one of this task's attachments → just reference it; a workspace / library file is linked (shown from where it is);
            // only what lives elsewhere (a worktree, a run folder that is cleaned later) is copied in
            const own = await realpath(this.attachments.dir(ctx.taskId)).catch(() => this.attachments.dir(ctx.taskId));
            const name = dirname(real) === own ? basename(real) : await this.attachments.link(ctx.taskId, real).catch(() => this.attachments.adopt(ctx.taskId, real));
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
        deadline.pause(); // the person's thinking time is not the agent's run time (E-02)
        try {
          const answer = await this.questions.ask(ctx.taskId, session.id, {
            ...input,
            // the picture shown with the question must be a real file of this task (never an arbitrary path)
            image: input.image ? await this.media.safePath(input.image, mediaRoots, ctx.taskId).catch(() => undefined) : undefined,
          });
          // what the person decided is team knowledge: it goes to the project's memory (decisions.md) by itself
          if (!opts.chat) void workspace.recordAnswer(input.question, answer);
          return answer;
        } finally {
          deadline.resume();
        }
      },
      onSearchResources: (input) => this.resources.searchReport(input, agentDef?.name, opts.project.slug),
      // A bare file name (as listed in the prompt: "IMG_4870.jpg (picture — use look_at)") means THIS task's attachment, like read_document.
      // The admin (it already reads every task via tasks_list / task_diagnose) may also open attachments of the task whose page the person is on.
      onLookAt: async (input) => this.media.lookAt(await this.attachmentOrPath(ctx.taskId, input.path, isAdminChat), input.question, mediaRoots, input, { provider: provider.name, model }, mediaScope),
      onVideoDigest: async (input) => this.media.videoDigest(await this.attachmentOrPath(ctx.taskId, input.path, isAdminChat), mediaRoots, input, mediaScope),
      onStartPreview: ctx.discussion ? undefined : () => this.preview.getOrStart(ctx.taskId, opts.workDir),
      onStopPreview: ctx.discussion ? undefined : async () => ({ stopped: this.preview.stop(ctx.taskId) }),
      onProposeLearnedSkill: ctx.discussion ? undefined : (input) => this.skillsLearned.propose(ctx.taskId, session.id, input.name, input.content),
      // Agent-management tools: the built-in admin agent only.
      admin: agentDef?.name === 'admin' && !ctx.discussion ? (adminScope ? scopeAdminTools(this.adminTools(ctx.taskId, session.id), adminScope) : this.adminTools(ctx.taskId, session.id)) : undefined,
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
      // Codex talks to OpenAI itself (ChatGPT login / API key) — no Anthropic env, no LiteLLM route.
      // Inside the try: a LiteLLM that is down / refuses the route is a provider-level failure
      // to fail over from, not a crash of run() that fails the task (X-FO-4).
      const modelEnv: AgentModelEnv = isCodex ? { ANTHROPIC_MODEL: model } : await this.resolveModelEnv(provider, model);
      const result = await runtimeForProviderKind(provider.kind).run(
        {
          prompt: withRunContext(await this.promptWithAttachments(prompt, opts), opts.runContext),
          cwd: opts.workDir,
          workspaceRoot: ctx.worktreePath,
          extraWriteRoots,
          modelEnv,
          providerLabel: provider.name,
          modelLabel: model,
          // An agent's own limit (its file's `maxTurns`) wins over the installation's AGENT_MAX_TURNS.
          maxTurns: agentDef?.maxTurns ?? limits.maxTurns,
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
          niceness: this.config.agentNice,
          nodeMaxMb: this.config.agentNodeMaxMb,
          isolation: opts.isolation ?? undefined,
          onProgress: () => {
            lastEventAt = Date.now();
          },
          onPartialUsage: (step) => {
            partial = addTotals(partial, step);
          },
          ...toolHandlers,
        },
        onEvent,
      );
      // The run this timer bounds is over — disarm it NOW, not in finally: the
      // reporting-resume below (own controller, own 90s cap) would otherwise
      // race it, and a late firing would stamp timedOut/abort onto a run that
      // actually completed. (finally still clears it on the throw paths.)
      deadline.clear();
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
      // Usage is attributed to THIS session (its provider): the DELTA of the
      // session's running totals against what earlier rows of the same session
      // hold (X-COST-1), subagents included (X-COST-2), the per-step partial
      // when no result arrived (X-COST-3). The reporting-resume's own share —
      // when it runs — is added so the extra turn isn't dropped from the stats.
      let usage: RunUsage = accountRunUsage(result, baseline, partial);
      const willFailover = result.isError && isFailoverWorthy(result.result);
      // Boundary for the salvage below: events at seq >= this belong to the
      // reporting-resume turn, not the original run.
      const preResumeSeq = seq;
      // Skipped for a verify-fix / schedule-check run (the caller re-verifies anyway — E-07).
      if (!opts.chat && !ctx.skipReportingResume && !reported.value && !abortController.signal.aborted && !willFailover && finalSessionId) {
        const resume = await this.reportingResume({
          sessionId: finalSessionId,
          codex: codexOpts,
          workDir: opts.workDir,
          worktreePath: ctx.worktreePath,
          extraWriteRoots,
          settingsDir: join(this.config.agentDir, 'runs', ctx.taskId),
          modelEnv,
          provider,
          model,
          appendSystemPrompt: opts.appendSystemPrompt,
          allowedTools: opts.agentDef?.allowedTools,
          disallowedTools: opts.agentDef?.disallowedTools,
          mcpServers: opts.mcpServers,
          hook,
          niceness: this.config.agentNice,
          nodeMaxMb: this.config.agentNodeMaxMb,
          isolation: opts.isolation,
          onReportStatus,
          onHeartbeat,
          onEvent,
        });
        // The resume continues the same session: its totals include the main run.
        usage = addUsage(usage, reportingResumeUsage({ sessionTotals: result.sessionTotals ?? totalsAfter(baseline, usage) }, resume));
        await writeChain;
      }

      // If report_task_status STILL wasn't called (the agent skipped it even on
      // the reporting resume), salvage a summary from its last message so the
      // task doesn't end with an empty summary. Clearly marked as auto-generated
      // — it is NOT an agent-attested outcome. Bounded to the ORIGINAL run: the
      // resume turn appends to the same session with higher seq, and its reply
      // ("Understood…") is a response to our resume prompt — not the agent's own
      // last word.
      let fallbackSummary: string | undefined;
      let finalText: string | undefined;
      if (!reported.value) {
        finalText = await this.salvageFinalText(session.id, preResumeSeq);
        if (finalText) fallbackSummary = `(auto-summary — agent did not call report_task_status)\n${finalText}`;
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
          memoryStopped,
          maxTurns: result.maxTurnsExceeded,
          finalText,
          // The provider's own words when the run failed (X-FO-6) — not for an abort, which is ours.
          errorText: result.isError && !aborted ? errorTextOf(result.result) : undefined,
        },
        failoverWorthy,
        reason: failoverWorthy ? shortReason(result.result) : '',
      };
    } catch (err) {
      // runAgent only rethrows for a genuine (non-abort) SDK/transport error.
      await writeChain.catch(() => undefined);
      const message = (err as Error).message;
      // What was spent before the failure (per-step usage) is still spent — X-COST-3.
      const spent = accountRunUsage({ usage: emptyUsage() }, baseline, partial);
      await this.prisma.agentSession
        .update({
          where: { id: session.id },
          data: {
            status: 'errored',
            claudeSessionId: tagSessionId(capturedSessionId, isCodex),
            endedAt: new Date(),
            inputTokens: spent.inputTokens,
            outputTokens: spent.outputTokens,
            cacheReadTokens: spent.cacheReadTokens,
            cacheCreationTokens: spent.cacheCreationTokens,
            numTurns: spent.numTurns,
            costUsd: spent.costUsd,
            apiMs: spent.apiMs,
          },
        })
        .catch(() => undefined);
      this.publishAgentStatus(ctx.taskId, session.id, 'errored');
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
      // The agent's last word (an implicit question) survives a thrown error too (E-13).
      const finalText = reported.value ? undefined : await this.salvageFinalText(session.id, seq);
      return {
        outcome: {
          reported: reported.value ? reported.value.status : null,
          reportedSummary: reported.value ? (reportText(reported.value) ?? undefined) : undefined,
          errored: true,
          timedOut,
          memoryStopped,
          maxTurns,
          finalText,
          errorText: aborted ? undefined : errorTextOf(message),
        },
        failoverWorthy,
        reason: failoverWorthy ? shortReason(message) : '',
      };
    } finally {
      deadline.clear();
      unsubscribeBus();
      if (idleTimer) clearInterval(idleTimer);
      internalReg?.dispose();
      if (this.active.get(ctx.taskId) === abortController) this.active.delete(ctx.taskId);
      this.guarded.delete(ctx.taskId);
      if (this.guarded.size === 0) this.stopMemoryGuard();
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
  private async promptWithAttachments(prompt: string, opts: { chat?: boolean; attachmentPaths: string[]; attachmentOriginals: Record<string, string>; listedAttachments: string[]; messageAttachments: string[] }): Promise<string> {
    if (!opts.chat) return withAttachments(prompt, opts.listedAttachments, opts.attachmentOriginals);
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
      const list = others.map((p) => `- ${basename(p)}${isVideoName(p) ? ' (video — use video_digest, then look_at)' : isImageName(p) ? ' (picture — use look_at)' : ' (read it with read_document)'}`).join('\n');
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
    extraWriteRoots?: string[];
    settingsDir: string;
    modelEnv: AgentModelEnv;
    provider: Provider;
    model: string;
    appendSystemPrompt: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    mcpServers: Record<string, Record<string, unknown>>;
    hook: HookWiring;
    /** CPU niceness for the run (AGENT_NICE). */
    niceness?: number;
    /** Heap cap for the Node processes the agent starts (AGENT_NODE_MAX_MB / automatic). */
    nodeMaxMb?: number;
    isolation: AgentIsolation | null;
    onReportStatus: (report: ReportedStatus) => void;
    onHeartbeat: () => void;
    onEvent: (event: AgentEvent) => void;
  }): Promise<{ usage: RunUsage; sessionTotals?: SessionTotals }> {
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
          extraWriteRoots: opts.extraWriteRoots,
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
          niceness: this.config.agentNice,
          nodeMaxMb: this.config.agentNodeMaxMb,
          isolation: opts.isolation ?? undefined,
          onReportStatus: opts.onReportStatus,
          onHeartbeat: opts.onHeartbeat,
        },
        opts.onEvent,
      );
      return { usage: r.usage, sessionTotals: r.sessionTotals };
    } catch (err) {
      this.logger.warn(
        `Reporting-resume failed for session ${opts.sessionId}: ${(err as Error).message}`,
      );
      return { usage: emptyUsage() };
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
  /** Is `taskId` a subtask (at any depth) of `ancestorId`? A lead may show what ITS subtasks produced, nothing else of other tasks. */
  private async isDescendantTask(taskId: string, ancestorId: string): Promise<boolean> {
    let cur: string | null = taskId;
    for (let hops = 0; cur && hops < 12; hops++) {
      const row: { parentId: string | null } | null = await this.prisma.task.findUnique({ where: { id: cur }, select: { parentId: true } });
      if (!row) return false;
      if (row.parentId === ancestorId) return true;
      cur = row.parentId;
    }
    return false;
  }

  /** Watches the memory while any run is in flight: below the guard, the newest run is stopped by us instead of the kernel killing the whole service. */
  private startMemoryGuard(): void {
    if (this.guardTimer || this.config.agentOomGuardMb <= 0) return;
    this.guardTimer = setInterval(() => {
      if (Date.now() - this.lastGuardStopAt < GUARD_GRACE_MS) return;
      const mem = readMemInfo();
      if (!mem.reliable) return; // not Linux: no trustworthy figure
      const victim = oomVictim(
        [...this.guarded].map(([taskId, g]) => ({ taskId, startedAt: g.startedAt })),
        mem.availableMb,
        this.config.agentOomGuardMb,
      );
      if (!victim) return;
      this.logger.warn(`Memory guard: ${Math.round(mem.availableMb)} MB available (guard ${this.config.agentOomGuardMb} MB) — stopping the newest run, task ${victim}`);
      this.lastGuardStopAt = Date.now();
      this.guarded.get(victim)?.stop(mem.availableMb);
      this.guarded.delete(victim);
      if (this.guarded.size === 0) this.stopMemoryGuard();
    }, 2000);
    this.guardTimer.unref?.();
  }

  private stopMemoryGuard(): void {
    if (this.guardTimer) clearInterval(this.guardTimer);
    this.guardTimer = null;
  }

  /**
   * The run reached its ceiling of active time while still working: a card asks a person whether it may go on. Approve = `extraMin` more
   * minutes (asked again when they are used up); deny, no answer in time or no card possible = the run stops here (the task becomes stalled).
   */
  private async askForMoreTime(taskId: string, agentSessionId: string, usedMin: number, extraMin: number, onEvent: (e: AgentEvent) => void): Promise<number> {
    try {
      const approvals = this.moduleRef.get(ApprovalsService, { strict: false });
      const toolInput = { usedMin, limitMin: usedMin, extraMin };
      const res = await approvals.check({ taskId, agentSessionId, toolName: EXTEND_RUN_TOOL, toolInput });
      if (res.allow) {
        // no-approvals mode (or an exception): granted without a card
        onEvent({ kind: 'stderr', text: `agent has worked ${usedMin} min and is still making progress — ${extraMin} more minutes granted automatically (no-approvals mode)` });
        return extraMin * 60_000;
      }
      if (!res.approvalId) return 0;
      onEvent({ kind: 'stderr', text: `agent has worked ${usedMin} min and is still making progress — waiting for a person to allow ${extraMin} more minutes` });
      const verdict = await approvals.waitForVerdict(res.approvalId);
      if (verdict.status === 'approved') {
        onEvent({ kind: 'stderr', text: `${extraMin} more minutes allowed` });
        return extraMin * 60_000;
      }
      return 0;
    } catch (e) {
      this.logger.warn(`Could not ask for more time (task ${taskId}): ${(e as Error).message}`);
      return 0;
    }
  }

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
      await this.litellm.ensureRoute(provider.name, model, routeParams(provider));
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
   * work. Empty string when the task has no references. With `since` (a
   * resumed session), only references added after that moment — the earlier
   * ones are already in the conversation (E-05).
   */
  private async buildReferencesContext(taskId: string, since?: Date): Promise<string> {
    const links = await this.prisma.taskLink.findMany({
      where: { fromTaskId: taskId, ...(since ? { createdAt: { gt: since } } : {}) },
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
      `These related tasks were ${since ? 'added since your last run' : 'referenced'}; consider their outcomes before implementing:\n` +
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
    project: Pick<ProjectContext, 'id' | 'slug' | 'repoPath'>,
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
        prompt: `${orientation}\n\n${await this.buildInstructions(def, project)}`,
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
      await this.litellm.ensureRoute(provider.name, model, routeParams(provider));
      return routeName(provider.name, model);
    }
    return model;
  }

  /**
   * Build the system-prompt append, top to bottom:
   *   1. global SOUL  (<agentDir>/SOUL.md — fleet charter, all agents)
   *   2. project SOUL (<the project's checkout>/SOUL.md — project charter)
   *   3. the chosen agent's body
   *   4. the global "Agent instructions" from Settings — appended for EVERY agent (E-21)
   *   5. skill files from <agentDir>/skills (all, or the subset the agent declares)
   *   6. the resource index (the task's project library first, then the global one) and the knowledge bases it may search
   */
  private async buildInstructions(agent: AgentDef | null, project: Pick<ProjectContext, 'id' | 'slug' | 'repoPath'>): Promise<string> {
    const parts: string[] = [];
    const repoPath = project.repoPath;

    // SOUL is always on, regardless of which agent/role runs.
    const globalSoul = (await this.readCached(join(this.config.agentDir, 'SOUL.md')))?.trim() || null;
    if (globalSoul) parts.push(globalSoul);
    const projectSoul = (await this.readCached(join(repoPath, 'SOUL.md')))?.trim() || null;
    if (projectSoul) parts.push(projectSoul);
    if (globalSoul || projectSoul) {
      this.logger.log(`SOUL loaded (global=${!!globalSoul}, project=${!!projectSoul})`);
    }

    // The agent's own body, then the Settings "Agent instructions" for every agent
    // (what the UI, the admin tool and the docs promise — not a fallback).
    const own = (agent?.instructions ?? '').trim();
    if (own) parts.push(own);
    const global = (await this.settings.agentInstructions()).trim();
    if (global && global !== own) parts.push(global);

    const skillsDir = join(this.config.agentDir, 'skills');
    try {
      // Recursive so the core/ + learned/ split is picked up; match by basename
      // since agents reference skills by bare name (e.g. `nestjs`).
      let files = (await readdir(skillsDir, { recursive: true })).filter(
        (f) => isListedMarkdown(f),
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
    // The resource libraries — the task's project library first, then the global one (an agent that cannot read files — the tools-only admin — gets the tool instead).
    if (agent?.mode !== 'chat' && !(agent?.disallowedTools ?? []).some((t) => /^read$/i.test(t))) {
      const block = await this.resources.promptIndex(agent?.name, project.slug);
      if (block) parts.push(block);
    }
    // Knowledge bases: one line per base this agent may search here — global ones and the project's (the content stays out of the prompt).
    const kbBlock = await this.knowledge.promptBlock(agent?.name ?? null, { projectId: project.id }).catch(() => '');
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
 * Static for a task (no file list): the project map travels in the run's message
 * (prompt-layers.ts), and a sub-agent runs `git ls-files` itself.
 */
function buildOrientation(workDir: string, worktreeRoot: string, branch: string | null, shared = false, project?: ProjectContext, remoteTools = false): string {
  const kind = shared
    ? 'the project repository (the shared main working directory)'
    : 'a dedicated git worktree (an isolated checkout of the project repository) created for this task';
  const lines = [
    '## Your workspace',
    ...(project ? [`- project: **${project.name}** (\`${project.slug}\`${project.isDefault ? ', the default project' : ''})`] : []),
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
  if (project) lines.push('', ...projectFacts(project, { fetch: remoteTools, push: remoteTools }));
  return lines.join('\n');
}

/** Orientation for a task of a docs project (docs/plan-projects-workspace.md §2.5): the cwd is the project's `work/` folder; no repository. */
function buildDocsOrientation(workDir: string, project: Pick<ProjectContext, 'name' | 'slug'>): string {
  return [
    '## Your workspace',
    `- project: **${project.name}** (\`${project.slug}\`) — a docs project: notes, drafts, data and results, no code repository`,
    `- working directory: \`${workDir}\` — the project's \`work/\` folder; write freely here`,
    'There is no git repository, branch or dev server here; do not run builds or tests. Finished results go to',
    '`deliverables/` with `workspace_save`; decisions and open questions to memory with `workspace_note`.',
  ].join('\n');
}

/**
 * A compact map of the project's git-tracked files, handed to the lead in its
 * message (prompt-layers.ts) so it doesn't burn turns discovering structure.
 * `.gitignore` already keeps node_modules/build output out. Lists files when
 * few; summarizes per top-level directory when many. Best-effort — '' on error.
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

/** File extension for an image media type (defaults to png). */
function extForMedia(mediaType: string): string {
  const sub = (mediaType.split('/')[1] || 'png').toLowerCase();
  if (sub === 'jpeg') return 'jpg';
  return ['png', 'jpg', 'webp', 'gif'].includes(sub) ? sub : 'png';
}

/** Extract a single-line YAML frontmatter field (e.g. `description`) if present. */
function frontmatterField(raw: string, field: string): string | null {
  return parseFrontmatter(raw)?.fields[field] ?? null;
}

/** First non-empty, non-frontmatter, non-heading line — a fallback summary. */
function firstProseLine(raw: string): string | null {
  const body = parseFrontmatter(raw)?.body ?? raw;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && !t.startsWith('---')) return t.slice(0, 160);
  }
  return null;
}

/** Append attachment paths to the prompt so the agent views them via Read. */
const READ_DOCUMENT_CHARS = 12_000;

function withAttachments(prompt: string, paths: string[], originals: Record<string, string> = {}): string {
  if (!paths.length) return prompt;
  const isVideo = (p: string) => isVideoName(p);
  const list = paths
    .map((p) => `- ${p}${originals[basename(p)] ? `  (uploaded as «${originals[basename(p)]}»)` : ''}${isVideo(p) ? '  (video — use video_digest, then look_at if you need to see it)' : ''}`)
    .join('\n');
  const lead = prompt.trim() ? prompt : 'Review the attached file(s).';
  const hasVideo = paths.some(isVideo);
  return `${lead}\n\nAttached files (use the Read tool to view photos, documents and text${hasVideo ? '; for a video call the video_digest tool — frames and what was said — and look_at to ask a question about what is shown' : ''}):\n${list}`;
}
