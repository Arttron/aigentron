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
  | 'onCreateTask'
  | 'onPushBranch'
  | 'onFetchRemote'
  | 'onCheckSubtasks'
  | 'onCompleteSubtask'
  | 'onScheduleCheck'
  | 'onSearchResources'
  | 'kb'
  | 'workspace'
  | 'onReadDocument'
  | 'onShowImages'
  | 'onCurrentTime'
  | 'browserProxy'
  | 'onCompressResult'
  | 'onAskUser'
  | 'onLookAt'
  | 'onVideoDigest'
  | 'onStartPreview'
  | 'onStopPreview'
  | 'onProposeLearnedSkill'
  | 'admin'
>;

/** Build the list of internal tools that are wired (have a callback) for this run. */
/** The tools' frame options (snake_case for the model) → the camelCase plan the server uses. */
function framePlan(args: Record<string, unknown>): { everySeconds?: number; atSeconds?: number[]; phrases?: string[]; pointing?: boolean } {
  return {
    ...(typeof args.every_seconds === 'number' ? { everySeconds: args.every_seconds } : {}),
    ...(Array.isArray(args.at_seconds) ? { atSeconds: args.at_seconds as number[] } : {}),
    ...(Array.isArray(args.phrases) ? { phrases: args.phrases as string[] } : {}),
    ...(args.pointing === true ? { pointing: true } : {}),
  };
}

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

  if (params.onPushBranch) {
    specs.push({
      name: 'push_branch',
      description:
        "Publish a LOCAL committed branch to origin. The ONLY way to push: `git push` from Bash cannot work (no credentials — do not try or ask for a token). `branch`; `to?` (remote branch name, default the same); `reason` (ONE line for the approval card). A person approves every push; never forces (a rejected non-fast-forward is reported). Returns what happened.",
      shape: { branch: z.string(), to: z.string().optional(), reason: z.string().optional() },
      handler: (args) =>
        params.onPushBranch!({
          branch: String(args.branch ?? ''),
          to: typeof args.to === 'string' && args.to.trim() ? args.to.trim() : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
        }),
    });
  }

  if (params.onFetchRemote) {
    specs.push({
      name: 'fetch_remote',
      description:
        "Download the latest commits of origin so `origin/<branch>` is current. The ONLY way to fetch or pull: `git fetch/pull` from Bash cannot authenticate (no credentials — do not try to fix it or ask for a token). `branch?` (default the project's; `all`). Changes none of your files — then merge/rebase `origin/<branch>` yourself. No approval needed.",
      shape: { branch: z.string().optional() },
      handler: (args) => params.onFetchRemote!({ branch: typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined }),
    });
  }

  if (params.onCreateTask) {
    specs.push({
      name: 'create_task',
      description:
        "Start a NEW top-level task in a project — independent work for someone else (for parts of this task use create_subtask). `project` (slug; \"default\"), `prompt` (a complete brief in terse English — the new task does not see this conversation), `title?`, `agent?` (else the project's default), `reason` (ONE line, shown first on the approval card), `related` (task ids whose summaries fold in). A person approves each; an equivalent open task is returned instead of a duplicate — check what exists first.",
      shape: { project: z.string(), prompt: z.string(), title: z.string().optional(), agent: z.string().optional(), reason: z.string().optional(), related: z.array(z.string()).optional() },
      handler: (args) =>
        params.onCreateTask!({
          project: String(args.project ?? '').trim(),
          prompt: String(args.prompt ?? ''),
          title: typeof args.title === 'string' ? args.title : undefined,
          agent: typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          related: Array.isArray(args.related) ? args.related.map(String) : undefined,
        }),
    });
  }

  if (params.onCreateSubtask) {
    specs.push({
      name: 'create_subtask',
      description:
        "Split this task into a subtask in its own worktree. `prompt`: a full instruction in terse English (facts and the next action), `title?`, `agent?` (a specialist), `after?` (ids of EARLIER subtasks that must be done first: this one then waits and gets their results; without `after` it starts at once, in parallel with the others as far as the server allows). Order dependent steps with `after` (research → build → review); leave independent ones without it. Returns the subtask id. Call check_subtasks first: reuse an existing subtask and do not split what one subtask can do.",
      shape: { prompt: z.string(), title: z.string().optional(), agent: z.string().optional(), after: z.array(z.string()).optional() },
      handler: async (args) => {
        const created = await params.onCreateSubtask!({
          prompt: String(args.prompt),
          title: typeof args.title === 'string' ? args.title : undefined,
          agent: typeof args.agent === 'string' ? args.agent : undefined,
          after: Array.isArray(args.after) ? args.after.map(String) : undefined,
        });
        if (created.waiting?.length) return `Created subtask ${created.id} — "${created.title}". It is held: it starts when ${created.waiting.join(', ')} ${created.waiting.length > 1 ? 'are' : 'is'} done, with ${created.waiting.length > 1 ? 'their' : 'its'} result in its context.`;
        return created.reused
          ? `NOT created: an equivalent subtask is already open — ${created.id} «${created.title}». Wait for it (check_subtasks) instead of starting a duplicate.`
          : `Created and queued subtask ${created.id} — "${created.title}".${created.parallel ? ` The server runs ${created.parallel} task(s) at a time, so subtasks beyond that wait their turn.` : ''}`;
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

  if (params.onCompleteSubtask) {
    specs.push({
      name: 'complete_subtask',
      description:
        "Mark one of YOUR subtasks as done (`id` from check_subtasks). A subtask whose agent finished is already done; use this to accept one that ended blocked, stalled or failed when you do not need it any more or have dealt with it yourself, or one waiting as 'ready'. It must have finished its run (not still queued/running) and must belong to this task.",
      shape: { id: z.string() },
      handler: (args) => params.onCompleteSubtask!(String(args.id ?? '')),
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

  if (params.onSearchResources) {
    specs.push({
      name: 'resources_search',
      description:
        "Search the resource libraries you can see: this task's project library and the global one (notes, images, PDFs, documents that people keep for agents). Give a `query` (words that must all match title/description/tags) and/or a `tag`; with neither it lists the newest entries. Each result has its scope (the project's slug or global) and the file path — READ that path to use the resource (images and PDFs are readable too). Use it when a task may be covered by material the prompt's resource list did not show.",
      shape: { query: z.string().optional(), tag: z.string().optional() },
      handler: (args) =>
        params.onSearchResources!({
          query: typeof args.query === 'string' ? args.query : undefined,
          tag: typeof args.tag === 'string' ? args.tag : undefined,
        }),
    });
  }

  if (params.kb) {
    const kb = params.kb;
    specs.push(
      {
        name: 'kb_list',
        description: 'List the knowledge bases you can search (name, what is in it, size). Use before kb_search when you do not know which one fits.',
        shape: {},
        handler: () => kb.list(),
      },
      {
        name: 'kb_search',
        description:
          "Search the knowledge bases (regulations, manuals, saved pages). Returns the best passages with document id, passage number, source. `query`: a few key words IN THE LANGUAGE OF THE DOCUMENTS (no translation); `kb?` one base; `limit` (default 6). Prefer it over guessing; cite sources; try synonyms or another language if thin.",
        shape: { query: z.string(), kb: z.string().optional(), limit: z.number().optional() },
        handler: (args) => kb.search({ query: String(args.query ?? ''), kb: typeof args.kb === 'string' && args.kb ? args.kb : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined }),
      },
      {
        name: 'kb_read',
        description: 'Read a document of a knowledge base: with `chunk` the whole passage (use it to read around a search hit — previous/next passages), without it the outline of the document. `doc`: the document id from kb_search.',
        shape: { doc: z.string(), chunk: z.number().optional() },
        handler: (args) => kb.read({ doc: String(args.doc ?? ''), chunk: typeof args.chunk === 'number' ? args.chunk : undefined }),
      },
    );
    if (kb.add) {
      const add = kb.add;
      specs.push({
        name: 'kb_add',
        description: 'Add a note to a knowledge base so it can be found later (only bases that allow agents to add notes — kb_list says which). `kb`: its name; `title`; `text` (Markdown); `source` (where the facts came from — a URL or file). Add facts worth keeping, not chatter.',
        shape: { kb: z.string(), title: z.string(), text: z.string(), source: z.string().optional() },
        handler: (args) => add({ kb: String(args.kb ?? ''), title: String(args.title ?? ''), text: String(args.text ?? ''), source: typeof args.source === 'string' ? args.source : undefined }),
      });
    }
  }

  if (params.workspace) {
    const ws = params.workspace;
    specs.push(
      {
        name: 'workspace_info',
        description: 'The shared workspace: where the folders are (memory, work, deliverables), the rules for writing to them, and the current memory digest. Call it when you are unsure where something belongs.',
        shape: {},
        handler: () => ws.info(),
      },
      {
        name: 'workspace_files',
        description: 'List files of the shared workspace with sizes and dates. `dir`: memory | work | deliverables (default: all); `glob` (optional, e.g. "*.md"); `limit` (default 100).',
        shape: { dir: z.enum(['memory', 'work', 'deliverables']).optional(), glob: z.string().optional(), limit: z.number().optional() },
        handler: (args) => ws.files({ dir: typeof args.dir === 'string' ? args.dir : undefined, glob: typeof args.glob === 'string' ? args.glob : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined }),
      },
    );
    if (ws.note) {
      const note = ws.note;
      specs.push({
        name: 'workspace_note',
        description:
          "Record something the whole team should remember, in the shared workspace memory. `kind`: decision (what was decided and why), question (an open question), fact (a verified fact or requirement), status (REPLACES the one-screen status), plan. `text`: short and specific (≤2 KB), in the language of the person; for a decision include who decided and why. `resolves` (optional, with kind=question): the beginning of the question it answers. Use it instead of editing memory files by hand.",
        shape: { kind: z.enum(['decision', 'question', 'fact', 'status', 'plan']), text: z.string(), resolves: z.string().optional() },
        handler: (args) => note({ kind: String(args.kind ?? ''), text: String(args.text ?? ''), resolves: typeof args.resolves === 'string' ? args.resolves : undefined }),
      });
    }
    if (ws.save) {
      const save = ws.save;
      specs.push({
        name: 'workspace_save',
        description:
          "Save a finished result for the person into the workspace `deliverables/` folder (reports, BOMs, tables, drafts they will take). `path`: relative, e.g. reports/summary.md (no `..`); `content`: the text, OR `from`: the full path of an existing file (an attachment or a file you produced) to copy; `note` (optional): one line on what it is. An existing file is kept as a previous version. Returns the full path to mention to the person.",
        shape: { path: z.string(), content: z.string().optional(), from: z.string().optional(), note: z.string().optional() },
        handler: (args) => save({ path: String(args.path ?? ''), content: typeof args.content === 'string' ? args.content : undefined, from: typeof args.from === 'string' ? args.from : undefined, note: typeof args.note === 'string' ? args.note : undefined }),
      });
    }
  }

  if (params.onReadDocument) {
    specs.push({
      name: 'read_document',
      description:
        "Read the TEXT of a file: something the person attached to the task (give just its name, e.g. plan.md) or a file of the workspace / resource library (full path). Works for Markdown, text, CSV, JSON, HTML, PDF with a text layer and Word (.docx). Returns up to ~12 000 characters and says where to continue — call again with `from` (character offset) for the next part. Pictures: use look_at instead. Use it whenever the person attaches a file or mentions one; never say you cannot open attachments.",
      shape: { path: z.string(), from: z.number().optional() },
      handler: (args) => params.onReadDocument!({ path: String(args.path ?? ''), from: typeof args.from === 'number' ? args.from : undefined }),
    });
  }

  if (params.onShowImages) {
    specs.push({
      name: 'show_images',
      description:
        "Show pictures IN THE CHAT (one or an album of up to 10): generated images, charts, screenshots, frames. `paths`: image files (png, jpg, webp, gif) in the task's attachments, library or workspace, or `task:<subtask id>/<file>`; `caption`: one short line. Use it whenever the result IS a picture; several related images go in ONE call.",
      shape: { paths: z.array(z.string()), caption: z.string().optional() },
      handler: (args) => params.onShowImages!({ paths: Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : [], caption: typeof args.caption === 'string' ? args.caption : undefined }),
    });
  }

  if (params.onCurrentTime) {
    specs.push({
      name: 'current_time',
      description:
        "The current date and time — you have no clock of your own, so call this whenever the answer depends on \"now\" (today's date, the day of the week, how long ago something was, a deadline, a schedule). `timezone` (optional): an IANA name such as \"Europe/Kyiv\" or \"America/New_York\"; by default the server's timezone, which may not be where the user is — if it matters, ask the user or use what you know about them.",
      shape: { timezone: z.string().optional() },
      handler: async (args) => params.onCurrentTime!({ timezone: typeof args.timezone === 'string' && args.timezone.trim() ? args.timezone.trim() : undefined }),
    });
  }

  if (params.browserProxy) {
    const bp = params.browserProxy;
    specs.push({
      name: 'browser_proxy_list',
      description: "The proxies the operator saved for the server's browser (the `playwright` tools), by name — never their logins — and which one the browser goes through now. Read-only. Use it before choosing one.",
      shape: {},
      handler: async () => bp.list(),
    });
    specs.push({
      name: 'browser_proxy_use',
      description:
        "Make the server's browser (`playwright`, not the person's own browser) go through the saved proxy `name`, or `direct` for none. Use it when a page needs another country's / another address, as the task says. The choice is SHARED by every task using the browser: open connections are closed (navigate again afterwards), and when you are done put it back to what you found unless the person asked otherwise. You never see or ask for a proxy's login. Refused when the operator switched it off.",
      shape: { name: z.string() },
      handler: async (args) => bp.use(String(args.name ?? '')),
    });
  }

  if (params.onAskUser) {
    specs.push({
      name: 'ask_user',
      description:
        "Ask the HUMAN a question and wait — for a decision or a fact you cannot find yourself (do not guess or end your run with a question). `question`: short and specific. `options`: 2–6 buttons (omit for an open question); `multiple` (several choices); `allow_text` (default true); `image`: a path to show with it. Returns the answer; if nobody answers in time, pick the safest default or report blocked. Ask one thing at a time; do not ask what you can check yourself.",
      shape: { question: z.string(), options: z.array(z.string()).optional(), allow_text: z.boolean().optional(), multiple: z.boolean().optional(), image: z.string().optional() },
      handler: (args) =>
        params.onAskUser!({
          question: String(args.question ?? ''),
          options: Array.isArray(args.options) ? (args.options as unknown[]).map(String) : [],
          allowText: args.allow_text !== false,
          multiple: args.multiple === true,
          image: typeof args.image === 'string' && args.image ? args.image : undefined,
        }),
    });
  }

  if (params.onLookAt) {
    specs.push({
      name: 'look_at',
      description:
        "Answer a question about a PHOTO or VIDEO with the vision model (any agent). `path`: full path (library / workspace) or the attachment's file name as listed in the prompt. `question`: be specific. Video: frames spread over the clip (max 8); `every_seconds` sets the step; `pointing: true` and/or `phrases: [\"…\"]` pick the moments where the speaker points (\"look here\", \"вот тут\"); `at_seconds: [12, 40]` exact times. For video use video_digest first (it also gives the speech).",
      shape: { path: z.string(), question: z.string(), every_seconds: z.number().optional(), at_seconds: z.array(z.number()).optional(), phrases: z.array(z.string()).optional(), pointing: z.boolean().optional() },
      handler: (args) =>
        params.onLookAt!({ path: String(args.path), question: String(args.question ?? ''), ...framePlan(args) }),
    });
  }

  if (params.onVideoDigest) {
    specs.push({
      name: 'video_digest',
      description:
        "Turn a VIDEO into frames (paths to Read / pass to look_at) plus a timestamped transcript (`[0:12] …`) when speech recognition is set up. `path`: full path or the attachment's file name as listed. `every_seconds` (1–60 frames max; default ≈ one per 10 s); `pointing` / `phrases` pick frames at the moments those words are said; `at_seconds` exact times. A new frame plan re-takes frames, the transcript is kept. The first call is slow (cached afterwards).",
      shape: { path: z.string(), every_seconds: z.number().optional(), at_seconds: z.array(z.number()).optional(), phrases: z.array(z.string()).optional(), pointing: z.boolean().optional() },
      handler: (args) =>
        params.onVideoDigest!({ path: String(args.path), ...framePlan(args) }),
    });
  }

  if (params.onStartPreview) {
    specs.push({
      name: 'preview_worktree',
      description:
        "Start (or reuse) a live dev server for THIS task's worktree and get its URL, so you can preview your own in-progress changes in the browser (not the base app). Call it before navigating/screenshotting with the browser tools, then open the returned URL. Start it ONCE per check and call `stop_preview` as soon as the screenshots are taken: one process at a time, none left running (it is also stopped when the task finishes, but do not rely on that).",
      shape: {},
      handler: async () => {
        const { url } = await params.onStartPreview!();
        return `Preview of your worktree is live at ${url} — navigate the browser there.`;
      },
    });
  }

  if (params.onStopPreview) {
    specs.push({
      name: 'stop_preview',
      description:
        "Stop the preview dev server of THIS task (the one `preview_worktree` started). Call it right after you have taken the screenshots you need — no process should be left running. Safe to call when nothing is running. If you need the page again later, call `preview_worktree` again.",
      shape: {},
      handler: async () => ((await params.onStopPreview!()).stopped ? 'The preview server is stopped.' : 'No preview server was running.'),
    });
  }

  if (params.onProposeLearnedSkill) {
    specs.push({
      name: 'propose_learned_skill',
      description:
        "Propose a durable, fleet-wide observation for agent/skills/learned/<name>.md — standing guidance future runs should know (a project quirk, a workaround), not task notes (report_task_status) or one-off facts. `content`: complete markdown (REPLACES the file), under 16KB. Needs approval (blocks until decided).",
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
          "Create or replace an agent. `name` (lowercase letters/digits/-/_), `content`: the COMPLETE agent file — frontmatter (description required; optional provider, model, `escalation: provider/model, …` (stronger steps, cheaper first), `tier: cheap|mid|top` (model strength override), skills, allowedTools, disallowedTools, mcp, `maxTurns` 5–500, `createTasks: true` for a lead that starts tasks) then the system prompt. Needs approval (blocks until decided). Built-in agents cannot be overwritten.",
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
          "Create a provider or update one. `name`, `kind` (anthropic|openai|deepseek|ollama|codex), `model`, `authMode` (api-key|auth-token|oauth-token; codex: codex-login|api-key), `baseUrl?`, `makeDefault?`, `reason`. NO secret field: never type keys in the chat — after approval tell the user to paste the key in Settings → Providers → Edit. Needs approval.",
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
        name: 'packs_list',
        description:
          "List the ready-made content packs (e.g. English learning, Home renovation, Software team): what each contains (agents, skills, library notes, prepared schedules) and how much of it is already installed. Read-only. Offer the matching pack when the user describes such a project.",
        shape: {},
        handler: () => admin.packsList(),
      },
      {
        name: 'propose_pack_install',
        description:
          "Install a content pack `name` (from packs_list): agents, skills, starter notes, prepared schedules (created SWITCHED OFF). Existing items are left untouched (safe to re-run). Ask the user's time zone and pass `timezone` (IANA). `project?` (slug): notes go into that project's library (agents/skills are global). `reason` required. Needs approval; afterwards tell the user the \"next steps\" from the result.",
        shape: { name: z.string(), timezone: z.string().optional(), project: z.string().optional(), reason: z.string() },
        handler: async (args) =>
          (
            await admin.proposePackInstall({
              name: String(args.name),
              timezone: typeof args.timezone === 'string' && args.timezone.trim() ? args.timezone.trim() : undefined,
              project: typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined,
              reason: String(args.reason ?? ''),
            })
          ).message,
      },
      {
        name: 'propose_resource',
        description:
          "Add, change or delete a TEXT NOTE in a resource library (shared knowledge agents read: a profile, measurements, a glossary). `action`: create|update|append|delete. create: `title`, `text` (Markdown), `description?` (one line — when to read it), `tags?`, `agents?` (omit = all), `project?` (slug: only its tasks see it; omit = global). append: `id` + `text` = only the NEW lines, added at the end (history, logs — nothing already in the note is touched). update: `id` + changed fields (`text` REPLACES the whole note and is refused when it would drop most of it, unless `replace: true`). delete: `id`. Files/images are uploaded by the user (Resources). Search first to avoid duplicates. Needs approval.",
        shape: {
          action: z.enum(['create', 'update', 'append', 'delete']),
          replace: z.boolean().optional(),
          id: z.string().optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          tags: z.array(z.string()).optional(),
          agents: z.array(z.string()).optional(),
          text: z.string().optional(),
          project: z.string().optional(),
          reason: z.string(),
        },
        handler: async (args) => {
          const arr = (k: string) => (Array.isArray(args[k]) ? (args[k] as unknown[]).map(String) : undefined);
          const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
          return (
            await admin.proposeResource({
              action: args.action as 'create' | 'update' | 'append' | 'delete',
              replace: args.replace === true ? true : undefined,
              id: str('id')?.trim() || undefined,
              title: str('title'),
              description: str('description'),
              tags: arr('tags'),
              agents: arr('agents'),
              text: str('text'),
              project: str('project')?.trim() || undefined,
              reason: String(args.reason ?? ''),
            })
          ).message;
        },
      },
      {
        name: 'channels_list',
        description:
          'List the chat channels (Telegram): name, on/off, whether the bot token is set, a live connectivity check, the allowed chats, the default agent, and the chats that have written to the bot but are NOT allowed yet (with their chat id and first message) — those are who to ask the user about before allowing. Read-only.',
        shape: {},
        handler: () => admin.channelsList(),
      },
      {
        name: 'propose_channel',
        description:
          "Create, change or delete a chat channel. `action`: create|update|delete; `name`. create: `kind` \"telegram\" — created SWITCHED OFF without a token; then call request_secret (target \"channel\", name) so the user enters the BotFather token securely. update: `enabled`, `defaultAgent`, `allowChatId` (only a chat id the user confirmed, usually waiting in channels_list — an allowed chat can create tasks and approve actions), `removeChatId`. `reason` required. Needs approval.",
        shape: {
          action: z.enum(['create', 'update', 'delete']),
          name: z.string(),
          kind: z.string().optional(),
          enabled: z.boolean().optional(),
          defaultAgent: z.string().optional(),
          allowChatId: z.string().optional(),
          removeChatId: z.string().optional(),
          reason: z.string(),
        },
        handler: async (args) => {
          const opt = (k: string) => (typeof args[k] === 'string' && String(args[k]).trim() ? String(args[k]).trim() : undefined);
          return (
            await admin.proposeChannel({
              action: args.action as 'create' | 'update' | 'delete',
              name: String(args.name),
              kind: opt('kind'),
              enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
              defaultAgent: opt('defaultAgent'),
              allowChatId: opt('allowChatId'),
              removeChatId: opt('removeChatId'),
              reason: String(args.reason ?? ''),
            })
          ).message;
        },
      },
      {
        name: 'chats_search',
        description:
          'Search the conversations of ALL tasks (what was asked and answered, in any language): returns the matching tasks (id, title, status) with the matching messages. Several words must all be present; \"quotes\" = an exact phrase; -word leaves a word out. `scope`: all (default) | mine (messages people wrote) | agents | results (final answers). Use it for \"what did we decide about X\" / \"find the chat where we talked about Y\", then tell the person which task (id, /tasks/<id>) and what was said. Read-only.',
        shape: { q: z.string(), scope: z.enum(['all', 'mine', 'agents', 'results']).optional(), limit: z.number().int().min(1).max(10).optional() },
        handler: async (args) =>
          admin.chatsSearch({ q: String(args.q ?? ''), scope: args.scope as 'all' | 'mine' | 'agents' | 'results' | undefined, limit: typeof args.limit === 'number' ? args.limit : undefined }),
      },
      {
        name: 'schedules_list',
        description:
          'List the recurring jobs (reminders and periodic tasks): name, when it runs (in words), kind, target chat/agent, next run, last result. Read-only.',
        shape: {},
        handler: () => admin.schedulesList(),
      },
      {
        name: 'propose_schedule',
        description:
          "Create, change or delete a recurring job (once per job; not allowed in propose_batch). `action`: create|update|delete; `name`. `cron` (5 fields, min 5 minutes apart, e.g. \"30 9 * * *\"), `timezone` (IANA — ask the user), `kind`: \"message\" (posts `text`, no model, free), \"task\" (starts a task with `text` for `agentName`; `taskMode` \"same\" = one task that remembers, default, or \"new\") or \"script\" (runs the shell script `text` on the server, no model, free, up to 20000 characters, the approval card shows all of it; `timeoutSec` default 600; `notifyOn` \"always\"|\"failure\"; files left in $LDS_OUTPUT_DIR go to the chat), `channel` (name) + `chatId` (an allowed chat, see channels_list), optional `quietStart`/`quietEnd` (HH:MM), `enabled`. `reason` required. Needs approval (blocks until decided).",
        shape: {
          action: z.enum(['create', 'update', 'delete']),
          name: z.string(),
          cron: z.string().optional(),
          timezone: z.string().optional(),
          kind: z.enum(['message', 'task', 'script']).optional(),
          text: z.string().optional(),
          timeoutSec: z.number().int().optional(),
          notifyOn: z.enum(['always', 'failure']).optional(),
          agentName: z.string().optional(),
          taskMode: z.enum(['same', 'new']).optional(),
          channel: z.string().optional(),
          chatId: z.string().optional(),
          quietStart: z.string().optional(),
          quietEnd: z.string().optional(),
          enabled: z.boolean().optional(),
          reason: z.string(),
        },
        handler: async (args) => {
          const opt = (k: string) => (typeof args[k] === 'string' && String(args[k]).trim() ? String(args[k]).trim() : undefined);
          return (
            await admin.proposeSchedule({
              action: args.action as 'create' | 'update' | 'delete',
              name: String(args.name),
              cron: opt('cron'),
              timezone: opt('timezone'),
              kind: opt('kind') as 'message' | 'task' | 'script' | undefined,
              text: typeof args.text === 'string' ? args.text : undefined,
              timeoutSec: typeof args.timeoutSec === 'number' ? args.timeoutSec : undefined,
              notifyOn: opt('notifyOn') as 'always' | 'failure' | undefined,
              agentName: opt('agentName'),
              taskMode: opt('taskMode') as 'same' | 'new' | undefined,
              channel: opt('channel'),
              chatId: opt('chatId'),
              quietStart: opt('quietStart'),
              quietEnd: opt('quietEnd'),
              enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
              reason: String(args.reason ?? ''),
            })
          ).message;
        },
      },
      {
        name: 'update_status',
        description:
          "The installed version, the newest published release (with its release notes), whether this server can update itself (a bare-metal install can; a Docker install cannot — the user runs `aigentron update`), how many tasks are running, and the outcome of the last update. Read-only. Call it before proposing an update and tell the user what is new.",
        shape: {},
        handler: () => admin.updateStatus(),
      },
      {
        name: 'propose_update',
        description:
          "Update this server to a newer release: `version` (omit = latest); `force: true` only if interrupting running tasks is accepted. The server RESTARTS for 1–2 minutes — say so first and start no other work. `reason` required. Needs approval; returns once the update has started (the previous version is kept for `aigentron rollback`).",
        shape: {
          version: z.string().optional(),
          force: z.boolean().optional(),
          reason: z.string(),
        },
        handler: async (args) =>
          (
            await admin.proposeUpdate({
              version: typeof args.version === 'string' && args.version.trim() ? args.version.trim() : undefined,
              force: args.force === true,
              reason: String(args.reason ?? ''),
            })
          ).message,
      },
      {
        name: 'access_status',
        description:
          "Where the server answers: the allowed domain names (and whether they are enforced), the public address from PUBLIC_URL, and whether Cloudflare Access is set up / on. Read-only. Use it before proposing changes.",
        shape: {},
        handler: () => admin.accessStatus(),
      },
      {
        name: 'propose_allowed_domains',
        description:
          "Change the domain names this server answers to. `action`: add|remove|set|clear; `domains`: dev.example.com or *.example.com. localhost, IPs and single-word LAN names always work; once the list is non-empty OTHER public names stop working — keep the user's own address on it. `reason` required. Needs approval. PUBLIC_URL / listen address live in .env (point to `aigentron access`).",
        shape: {
          action: z.enum(['add', 'remove', 'set', 'clear']),
          domains: z.array(z.string()).optional(),
          reason: z.string(),
        },
        handler: async (args) =>
          (
            await admin.proposeAllowedDomains({
              action: args.action as 'add' | 'remove' | 'set' | 'clear',
              domains: Array.isArray(args.domains) ? args.domains.map(String) : undefined,
              reason: String(args.reason ?? ''),
            })
          ).message,
      },
      {
        name: 'propose_cloudflare_access',
        description:
          "Turn the server's Cloudflare Access check on/off. `enabled`; `teamDomain` (yourteam.cloudflareaccess.com); `aud` (the Application Audience tag, not a secret; optional if saved). When on, a request under a real domain without Cloudflare's signed token gets 403 (localhost, IPs, LAN unaffected). Checks that Cloudflare answers for the team first. `reason` required. Needs approval.",
        shape: {
          enabled: z.boolean(),
          teamDomain: z.string(),
          aud: z.string().optional(),
          reason: z.string(),
        },
        handler: async (args) =>
          (
            await admin.proposeCloudflareAccess({
              enabled: args.enabled === true,
              teamDomain: String(args.teamDomain ?? ''),
              aud: typeof args.aud === 'string' && args.aud.trim() ? args.aud.trim() : undefined,
              reason: String(args.reason ?? ''),
            })
          ).message,
      },
      {
        name: 'propose_batch',
        description:
          "Propose SEVERAL related changes behind ONE approval (use for 2+ changes). `items` (1–12, applied in order): {kind, args}: agent {name, content}; skill {name, content}; agent_delete {name, reason}; provider {name, kind, model, authMode, baseUrl?, makeDefault?, reason}; settings {changes, reason}; task {agentName, prompt, title?, reason}; task_action {action, taskIds, reason}. Not allowed: secrets, cleanup, undo, schedules. All items are validated first (invalid → nothing shown, you get the reasons); applied one by one, each journaled; a failure stops the batch and says what was applied.",
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
          "Start a task for another agent on the user's behalf: `agentName` (existing, not you), `prompt` (a complete brief), `title?`, `reason`. Runs right after approval and spends that agent's budget. By default a SUBTASK of this conversation (you are told when it finishes); `standalone: true` only for an independent long job. Returns the task id; check later with task_diagnose.",
        shape: { agentName: z.string(), prompt: z.string(), title: z.string().optional(), standalone: z.boolean().optional(), reason: z.string() },
        handler: async (args) =>
          (
            await admin.proposeTask({
              standalone: args.standalone === true,
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
          "Change a few platform settings. `changes` may contain ONLY: defaultAgent, verifyCommands (one per line; '' = off), verifyMaxAttempts (0–10), concurrency (1–16), approvalTimeoutSeconds (30–3600), agentInstructions (≤4000 chars, appended to EVERY agent), repoBranch, workspaceSubdir. Not available: repo URL, secrets, providers (use propose_provider), channels, users. The user sees old → new; old values are journaled for revert. `reason` required.",
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
        name: 'current_context',
        description:
          "Where the person is in the dashboard right now, and what is there: on a task page → that task's status, error, agent, runs, approvals, subtasks and last messages; on a project page → the project; elsewhere → the page's name. Call it when they say 'this task', 'here', 'this page', 'why did it fail' without an id. Read-only.",
        shape: {},
        handler: () => admin.currentContext(),
      },
      {
        name: 'metrics_report',
        description:
          "Read-only tables to CHECK a complaint or a setting against. `topic`: approvals | tasks | agents | config | system (machine load / memory / limits). `days` (default 7, max 365); `project` (slug) and `agent` narrow approvals/tasks/agents. Use before proposing a change and again after. Subscription costs are list-price estimates, not charges.",
        shape: { topic: z.enum(['approvals', 'tasks', 'agents', 'config', 'system']), days: z.number().optional(), project: z.string().optional(), agent: z.string().optional() },
        handler: (args) =>
          admin.metricsReport({
            topic: String(args.topic),
            days: typeof args.days === 'number' ? args.days : undefined,
            project: typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined,
            agent: typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined,
          }),
      },
      {
        name: 'usage_report',
        description:
          'Token, request and estimated-cost usage per provider over the last N days (default 7, max 365) — the numbers behind the Stats page; `project` (a slug) limits them to one project and adds a per-project breakdown. Subscription-based providers (Codex/ChatGPT) record tokens but no cost.',
        shape: { days: z.number().optional(), project: z.string().optional() },
        handler: (args) => admin.usageReport({ days: typeof args.days === 'number' ? args.days : undefined, project: typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined }),
      },
      {
        name: 'request_secret',
        description:
          "Ask the user to enter an API key / token in a SECURE field (a dashboard card; a one-time link on a phone/Telegram) — you never see the value. `target`: 'provider' (key of provider `name`), 'github_token' or 'channel' (bot token of channel `name`). `reason`: one line. Blocks until saved or cancelled. NEVER ask for a key in the chat.",
        shape: { target: z.enum(['provider', 'github_token', 'channel']), name: z.string().optional(), reason: z.string() },
        handler: async (args) =>
          (
            await admin.requestSecret({
              target: args.target as 'provider' | 'github_token' | 'channel',
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

  const compress = params.onCompressResult;
  if (!compress) return specs;
  return specs.map((s) => (COMPRESSIBLE_RESULTS.has(s.name) ? { ...s, handler: async (args: Record<string, unknown>) => compress(s.name, await s.handler(args)) } : s));
}

/** The tools whose answers can be long free text (never the control tools: status, approvals, task creation). */
const COMPRESSIBLE_RESULTS = new Set(['kb_search', 'kb_read', 'read_document', 'resources_search', 'workspace_files', 'look_at', 'video_digest', 'check_subtasks']);
