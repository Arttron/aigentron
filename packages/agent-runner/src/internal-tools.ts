import { z } from 'zod';
import type { ReportedStatus, RunAgentParams } from './types';

/**
 * Runtime-agnostic definition of one internal (control-plane) tool. The Claude
 * runtime wraps these as an in-process SDK MCP server; the Codex runtime has
 * them served over HTTP MCP by the orchestrator. Same handlers either way.
 */
export interface InternalToolSpec {
  name: string;
  description: string;
  /** zod raw shape (MCP tool input schema). */
  shape: Record<string, z.ZodTypeAny>;
  /** Resolves with the text shown to the agent. */
  handler: (args: Record<string, unknown>) => Promise<string>;
}

/** The slice of RunAgentParams that wires internal tools. */
export type InternalToolHandlers = Pick<
  RunAgentParams,
  | 'onReportStatus'
  | 'onHeartbeat'
  | 'onCreateSubtask'
  | 'onCheckSubtasks'
  | 'onScheduleCheck'
  | 'onStartPreview'
  | 'onProposeLearnedSkill'
  | 'admin'
>;

/** Build the list of internal tools that are wired (have a callback) for this run. */
export function buildInternalToolSpecs(params: InternalToolHandlers): InternalToolSpec[] {
  const specs: InternalToolSpec[] = [];

  if (params.onReportStatus) {
    specs.push({
      name: 'report_task_status',
      description:
        "Report the final outcome of this task. Call this exactly once, at the very end: status 'done' when the work is complete, 'blocked' when you need a human to proceed (put what you need in `handoff`), or 'failed' when you could not do it. This is the authoritative signal that ends the task.",
      shape: {
        status: z.enum(['done', 'failed', 'blocked']),
        summary: z.string().optional(),
        files: z.array(z.string()).optional(),
        handoff: z.string().optional(),
      },
      handler: async (args) => {
        const report = args as unknown as ReportedStatus;
        params.onReportStatus?.(report);
        return `Recorded task status: ${report.status}.`;
      },
    });
  }

  if (params.onHeartbeat) {
    specs.push({
      name: 'heartbeat',
      description:
        'Optional: signal you are still making progress on a long task. Call every few steps with a one-line note. Does NOT end the task — use report_task_status for that.',
      shape: { progress: z.string().optional() },
      handler: async (args) => {
        params.onHeartbeat?.({ progress: typeof args.progress === 'string' ? args.progress : undefined });
        return 'Heartbeat noted.';
      },
    });
  }

  if (params.onCreateSubtask) {
    specs.push({
      name: 'create_subtask',
      description:
        'Decompose this task into an independent subtask. Use it to split work into scoped units — each subtask runs on its own (its own worktree and agent) and starts immediately. Give a clear `prompt` (a full instruction, not a title), an optional short `title`, and optionally the specialist `agent` to run it (e.g. backend, frontend, coder). Returns the new subtask id. Prefer this over doing everything yourself when the work has distinct parts.',
      shape: { prompt: z.string(), title: z.string().optional(), agent: z.string().optional() },
      handler: async (args) => {
        const created = await params.onCreateSubtask!({
          prompt: String(args.prompt),
          title: typeof args.title === 'string' ? args.title : undefined,
          agent: typeof args.agent === 'string' ? args.agent : undefined,
        });
        return `Created and queued subtask ${created.id} — "${created.title}".`;
      },
    });
  }

  if (params.onCheckSubtasks) {
    specs.push({
      name: 'check_subtasks',
      description:
        "Check the current status and latest result of the subtasks you created for this task. Use it to see progress before deciding what to do next. You are also resumed automatically once all subtasks finish, so you don't need to poll in a loop.",
      shape: {},
      handler: async () => {
        const subs = await params.onCheckSubtasks!();
        return subs.length
          ? subs.map((s) => `- [${s.id}] «${s.title}» → ${s.status}: ${s.summary}`).join('\n')
          : 'No subtasks yet.';
      },
    });
  }

  if (params.onScheduleCheck) {
    specs.push({
      name: 'schedule_check',
      description:
        "Ask to be re-run after a delay — use this instead of claiming you'll 'check back in N minutes' (your run ends now and won't resume on its own). Give `delaySeconds` (30–3600) and an optional `note` of what to re-check. When it fires you're resumed with that note; re-check then (e.g. poll CI via the github MCP), and if it's still not done, call schedule_check again to keep watching. Report your status now and stop — don't sleep or loop in-run.",
      shape: { delaySeconds: z.number(), note: z.string().optional() },
      handler: async (args) => {
        const { delaySeconds } = await params.onScheduleCheck!({
          delaySeconds: Number(args.delaySeconds),
          note: typeof args.note === 'string' ? args.note : undefined,
        });
        return `Scheduled a re-check in ${delaySeconds}s. Ending this run now.`;
      },
    });
  }

  if (params.onStartPreview) {
    specs.push({
      name: 'preview_worktree',
      description:
        "Start (or reuse) a live dev server for THIS task's worktree and get its URL, so you can preview your own in-progress changes in the browser (not the base app). Call it before navigating/screenshotting with the browser tools, then open the returned URL. The server is torn down automatically when the task finishes.",
      shape: {},
      handler: async () => {
        const { url } = await params.onStartPreview!();
        return `Preview of your worktree is live at ${url} — navigate the browser there.`;
      },
    });
  }

  if (params.onProposeLearnedSkill) {
    specs.push({
      name: 'propose_learned_skill',
      description:
        "Propose writing a durable, fleet-wide observation to agent/skills/learned/<name>.md — something future agent runs (not just this one) should know, e.g. a project-specific quirk or gotcha you had to work around. This is NOT for task-specific notes (use report_task_status for those) and NOT for one-off facts — only for things worth a human approving as standing guidance. A human must approve the write before it lands (this call blocks until they decide); `content` should be complete markdown (this REPLACES the file, not appends). Keep it under 16KB — consolidate rather than let it grow unbounded.",
      shape: {
        name: z.string().describe('lowercase-with-hyphens, no extension, e.g. "checkout-service-quirks"'),
        content: z.string(),
      },
      handler: async (args) => {
        const result = await params.onProposeLearnedSkill!({ name: String(args.name), content: String(args.content) });
        return result.message;
      },
    });
  }

  if (params.admin) {
    const admin = params.admin;
    specs.push(
      {
        name: 'catalog_list',
        description:
          'List the agent TEMPLATES shipped with this release (name + one-line description). Templates are starting points, not live agents.',
        shape: {},
        handler: () => admin.catalogList(),
      },
      {
        name: 'catalog_get',
        description:
          'Get the full definition (frontmatter + system prompt) of one template, to tailor and then pass to propose_agent.',
        shape: { name: z.string() },
        handler: (args) => admin.catalogGet(String(args.name)),
      },
      {
        name: 'agents_list',
        description: 'List the agents that currently exist on this instance, and the skills available to them.',
        shape: {},
        handler: () => admin.agentsList(),
      },
      {
        name: 'agent_get',
        description:
          "Get the full current file (frontmatter + system prompt) of an EXISTING agent. Use it before changing an agent: copy it, apply the requested change, and pass the whole result to propose_agent.",
        shape: { name: z.string() },
        handler: (args) => admin.agentGet(String(args.name)),
      },
      {
        name: 'propose_agent',
        description:
          'Propose creating or replacing an agent. `name`: lowercase letters/digits/-/_. `content`: the COMPLETE agent file — frontmatter (description required; optional provider, model, skills, allowedTools, disallowedTools, mcp) followed by the system prompt. A human reviews the full content and must approve before anything is written; this call blocks until they decide. You cannot overwrite built-in agents.',
        shape: { name: z.string(), content: z.string() },
        handler: async (args) =>
          (await admin.proposeAgent({ name: String(args.name), content: String(args.content) })).message,
      },
      {
        name: 'propose_skill',
        description:
          'Propose creating or replacing a custom skill (a short markdown note an agent can opt into via `skills:` in its frontmatter). `name`: lowercase-with-hyphens, no extension. A human must approve before it is written; this call blocks until they decide.',
        shape: { name: z.string(), content: z.string() },
        handler: async (args) =>
          (await admin.proposeSkill({ name: String(args.name), content: String(args.content) })).message,
      },
      {
        name: 'tasks_list',
        description:
          "List the platform's tasks (the ones in the dashboard's task list — NOT a to-do list): id, status, agent, created, title. Optional `status` filter (queued, running, needs_approval, done, failed, cancelled, blocked, stalled), `limit` (default 50, max 200), `order` ('newest' default, or 'oldest' — use 'oldest' when asked to clean up OLD tasks) and `olderThanDays`. Always call this before proposing cancel/delete and use only the ids it returns.",
        shape: {
          status: z.string().optional(),
          limit: z.number().optional(),
          order: z.enum(['newest', 'oldest']).optional(),
          olderThanDays: z.number().optional(),
        },
        handler: (args) =>
          admin.tasksList({
            status: typeof args.status === 'string' ? args.status : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            order: typeof args.order === 'string' ? args.order : undefined,
            olderThanDays: typeof args.olderThanDays === 'number' ? args.olderThanDays : undefined,
          }),
      },
      {
        name: 'propose_task_action',
        description:
          "Propose cancelling or deleting specific platform tasks. `action`: 'cancel' (stop running/queued work) or 'delete' (remove the task, its transcript and worktree — irreversible). `taskIds`: the EXACT ids to act on (max 200; get them from tasks_list — never guess). `reason`: why. A human sees the list and must approve before anything happens; this call blocks until they decide. You cannot act on your own chat task.",
        shape: {
          action: z.enum(['cancel', 'delete']),
          taskIds: z.array(z.string()).min(1).max(200),
          reason: z.string(),
        },
        handler: async (args) =>
          (
            await admin.proposeTaskAction({
              action: args.action as 'cancel' | 'delete',
              taskIds: (args.taskIds as string[]).map(String),
              reason: String(args.reason ?? ''),
            })
          ).message,
      },
      {
        name: 'providers_list',
        description:
          'List the configured model providers: name, kind, model, auth mode, whether a key/token is set (never the secret itself) and which one is the default.',
        shape: {},
        handler: () => admin.providersList(),
      },
      {
        name: 'provider_test',
        description:
          'Run a connectivity check against a configured provider (sends a tiny request using the stored credentials) and report ok/failed with the error. Never reveals the secret.',
        shape: { name: z.string() },
        handler: (args) => admin.providerTest(String(args.name)),
      },
      {
        name: 'propose_provider',
        description:
          "Propose creating a provider or updating an existing one's configuration. Fields: `name`, `kind` (anthropic | openai | deepseek | ollama | codex), `model`, `authMode` (api-key | auth-token | oauth-token for non-codex; codex-login | api-key for codex), optional `baseUrl` (https://… endpoint; leave out for the family default), optional `makeDefault` (also set it as the default provider), `reason`. There is NO secret field: API keys/tokens must never be typed into this chat — after approval, tell the user to paste the key themselves in Settings → Providers → Edit. A human reviews the request and must approve before anything changes; this call blocks until they decide.",
        shape: {
          name: z.string(),
          kind: z.enum(['anthropic', 'openai', 'deepseek', 'ollama', 'codex']),
          model: z.string(),
          authMode: z.enum(['api-key', 'auth-token', 'oauth-token', 'codex-login']),
          baseUrl: z.string().optional(),
          makeDefault: z.boolean().optional(),
          reason: z.string(),
        },
        handler: async (args) =>
          (
            await admin.proposeProvider({
              name: String(args.name),
              kind: String(args.kind),
              model: String(args.model),
              authMode: String(args.authMode),
              baseUrl: typeof args.baseUrl === 'string' && args.baseUrl.trim() ? args.baseUrl.trim() : undefined,
              makeDefault: args.makeDefault === true,
              reason: String(args.reason ?? ''),
            })
          ).message,
      },
      {
        name: 'propose_batch',
        description:
          "Propose SEVERAL related changes behind ONE approval (the user approves once instead of N times). Use it whenever a request needs 2+ changes (e.g. create three agents + a provider, set up an agent and start its first task). `items` (1–12, applied IN ORDER; later items may refer to agents created by earlier ones): each is {kind, args} where kind/args are: agent {name, content}; skill {name, content}; agent_delete {name, reason}; provider {name, kind, model, authMode, baseUrl?, makeDefault?, reason}; settings {changes, reason}; task {agentName, prompt, title?, reason}; task_action {action, taskIds, reason}. Not allowed in a batch: secrets (use request_secret), cleanup, undo. The whole batch is validated first — if any item is invalid nothing is shown and you get the reasons; otherwise the user sees every item on one card. Items are journaled one by one (each can be reverted). If an item fails while applying, the batch stops there and the result says which items were applied.",
        shape: {
          items: z
            .array(
              z.object({
                kind: z.enum(['agent', 'skill', 'agent_delete', 'provider', 'settings', 'task', 'task_action']),
                args: z.record(z.string(), z.unknown()),
              }),
            )
            .min(1)
            .max(12),
          reason: z.string(),
        },
        handler: async (args) =>
          (
            await admin.proposeBatch({
              items: (args.items as { kind: string; args: Record<string, unknown> }[]) ?? [],
              reason: String(args.reason ?? ''),
            })
          ).message,
      },
      {
        name: 'propose_task',
        description:
          "Propose starting a task for another agent on the user's behalf: `agentName` (an existing agent other than yourself), `prompt` (the full instruction — a complete brief, not a title), optional `title`, `reason`. It runs immediately after approval and spends that agent's provider budget. You get the task id back; check progress/results later with task_diagnose. Use it when the user asks you to get something done by an agent (e.g. 'ask the researcher to find…').",
        shape: { agentName: z.string(), prompt: z.string(), title: z.string().optional(), reason: z.string() },
        handler: async (args) =>
          (
            await admin.proposeTask({
              agentName: String(args.agentName),
              prompt: String(args.prompt),
              title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined,
              reason: String(args.reason ?? ''),
            })
          ).message,
      },
      {
        name: 'admin_history',
        description:
          'Your change journal: what you changed for the user (id, time, tool, summary) and which changes can still be reverted with propose_undo. Newest first; `limit` default 20.',
        shape: { limit: z.number().optional() },
        handler: (args) => admin.adminHistory({ limit: typeof args.limit === 'number' ? args.limit : undefined }),
      },
      {
        name: 'propose_settings',
        description:
          "Propose changing a few platform settings. `changes` may contain ONLY: defaultAgent (an existing agent name), verifyCommands (shell commands run after each task, one per line; '' = off), verifyMaxAttempts (0–10), concurrency (1–16; ignored in shared workspace mode), approvalTimeoutSeconds (30–3600), agentInstructions (text appended to EVERY agent's prompt, ≤4000 chars), repoBranch, workspaceSubdir (relative folder inside the repo). Not available: repo URL, tokens/secrets, providers (use propose_provider), channels, users. The user sees old → new values and must approve; the old values are journaled so the change can be reverted. `reason` is required.",
        shape: {
          changes: z.object({
            defaultAgent: z.string().optional(),
            verifyCommands: z.string().optional(),
            verifyMaxAttempts: z.number().optional(),
            concurrency: z.number().optional(),
            approvalTimeoutSeconds: z.number().optional(),
            agentInstructions: z.string().optional(),
            repoBranch: z.string().optional(),
            workspaceSubdir: z.string().optional(),
          }),
          reason: z.string(),
        },
        handler: async (args) => (await admin.proposeSettings({ changes: (args.changes ?? {}) as Record<string, unknown>, reason: String(args.reason ?? '') })).message,
      },
      {
        name: 'propose_undo',
        description:
          'Propose reverting one of your earlier changes by its id from admin_history: restores the previous agent/skill file (or removes a newly created one), the previous provider configuration (or removes a newly created provider), or the previous settings values. Deleted tasks, cleanups and entered secrets cannot be reverted. The user must approve.',
        shape: { changeId: z.string(), reason: z.string() },
        handler: async (args) => (await admin.proposeUndo({ changeId: String(args.changeId), reason: String(args.reason ?? '') })).message,
      },
      {
        name: 'task_diagnose',
        description:
          "Explain why one platform task ended the way it did: status, error text, agent, provider/model, the agent's own reported summary, approvals (and their outcome), subtasks, and the last messages. Use the id from tasks_list. Read-only.",
        shape: { taskId: z.string() },
        handler: (args) => admin.taskDiagnose(String(args.taskId)),
      },
      {
        name: 'usage_report',
        description:
          'Token, request and estimated-cost usage per provider over the last N days (default 7, max 365) — the numbers behind the Stats page. Subscription-based providers (Codex/ChatGPT) record tokens but no cost.',
        shape: { days: z.number().optional() },
        handler: (args) => admin.usageReport({ days: typeof args.days === 'number' ? args.days : undefined }),
      },
      {
        name: 'request_secret',
        description:
          "Ask the user to enter an API key / token in a SECURE field (a card in the dashboard, a hidden prompt in the console) — the value goes straight to the server and you never see it. `target`: 'provider' (the key/token of the provider `name`) or 'github_token' (the GitHub token in Settings). `reason`: one line shown to the user. Blocks until they save or cancel; returns whether it was saved. NEVER ask the user to type a key in the chat — use this.",
        shape: { target: z.enum(['provider', 'github_token']), name: z.string().optional(), reason: z.string() },
        handler: async (args) =>
          (
            await admin.requestSecret({
              target: args.target as 'provider' | 'github_token',
              name: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined,
              reason: String(args.reason ?? ''),
            })
          ).message,
      },
      {
        name: 'maintenance_report',
        description:
          'Disk-usage report of what task runs leave behind: per-task run folders, old git worktrees (from the former per-task worktree mode) and `agent/task-*` branches in the project repository — with counts, sizes and how many are old enough to clean.',
        shape: {},
        handler: () => admin.maintenanceReport(),
      },
      {
        name: 'propose_cleanup',
        description:
          "Propose deleting old leftovers. `runs` (run folders), `worktrees` (old per-task git worktrees — the big space hog), `deleteBranches` (also delete the `agent/task-*` branches of finished tasks — their commits may never have been pushed, so only when the user explicitly agrees to lose them), `olderThanDays` (optional; defaults are 14 for runs and 30 for worktrees), `reason`. Live tasks are never touched. The user sees the exact numbers and must approve; this call blocks until they decide.",
        shape: {
          runs: z.boolean().optional(),
          worktrees: z.boolean().optional(),
          deleteBranches: z.boolean().optional(),
          olderThanDays: z.number().optional(),
          reason: z.string(),
        },
        handler: async (args) =>
          (
            await admin.proposeCleanup({
              runs: args.runs !== false,
              worktrees: args.worktrees === true,
              deleteBranches: args.deleteBranches === true,
              olderThanDays: typeof args.olderThanDays === 'number' ? args.olderThanDays : undefined,
              reason: String(args.reason ?? ''),
            })
          ).message,
      },
      {
        name: 'propose_agent_delete',
        description:
          'Propose deleting an existing agent (its file is snapshotted first). `name`: the agent; `reason`: why. A human must approve before anything happens; this call blocks until they decide. Built-in agents cannot be deleted.',
        shape: { name: z.string(), reason: z.string() },
        handler: async (args) =>
          (await admin.proposeAgentDelete({ name: String(args.name), reason: String(args.reason ?? '') })).message,
      },
    );
  }

  return specs;
}
