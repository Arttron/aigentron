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
        "Publish a LOCAL branch of this project's git repository to its remote (origin). This is the ONLY way to push: a `git push` from Bash cannot work (you have no credentials and no SSH key — do not try it, and do not ask for a token). `branch`: the local branch (it must exist and be committed: commit first); `to` (optional): the branch name on the remote (default: the same name; use it e.g. to publish `develop` as `main` in an empty repository); `reason`: ONE plain line on why (shown to the person on the approval card). A person approves every push; it never forces (a rejected non-fast-forward is reported, not overwritten). Returns what happened.",
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
        "Download the latest commits of this project's remote (origin) so `origin/<branch>` is current. This is the ONLY way to fetch or pull: `git fetch` / `git pull` from Bash cannot authenticate (you have no credentials and no SSH key — a `Host key verification failed` or `Permission denied` from your shell is expected: do not try to fix it, do not ask for a token). `branch` (optional): one branch (default: the project's branch; `all` fetches every branch). It changes none of your files or branches — afterwards bring the commits in yourself with plain git, e.g. `git merge origin/<branch>` or `git rebase origin/<branch>`. No approval needed. Returns what happened and the new head.",
      shape: { branch: z.string().optional() },
      handler: (args) => params.onFetchRemote!({ branch: typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined }),
    });
  }

  if (params.onCreateTask) {
    specs.push({
      name: 'create_task',
      description:
        "Start a NEW top-level task in a project — independent work for someone else, NOT a part of this task (for parts of this task use create_subtask: it stays in your project and is tracked under you). `project`: the project's slug (e.g. \"web\"; \"default\" for the default one); `prompt`: the full instruction, a complete brief in terse English; `title` (optional); `agent` (optional: the agent that should run it — otherwise the project's default agent); `reason`: ONE plain line on why this work is moved out (the person reads it first on the approval card); `related`: ids of the tasks it grows out of (they are linked, so their summaries fold into the new task's context). Write the brief so it stands on its own — the new task does not see this conversation. A person approves each one on a card, and if an equivalent task is already open in that project you get it back instead of a duplicate. Check what exists before you create: do not start the same work twice.",
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
        'Decompose this task into an independent subtask. Use it to split work into scoped units — each subtask runs on its own (its own worktree and agent) and starts immediately. Give a clear `prompt` — a full instruction, not a title, in terse English (facts and the next action; no pleasantries, no retelling of what the receiver can read itself) — an optional short `title`, and optionally the specialist `agent` to run it (e.g. backend, frontend, coder). Returns the new subtask id. Prefer this over doing everything yourself when the work has distinct parts. Before creating one, call check_subtasks: reuse a finished or running subtask that already covers it, and do not split work that one subtask can do — do not multiply tasks.',
      shape: { prompt: z.string(), title: z.string().optional(), agent: z.string().optional() },
      handler: async (args) => {
        const created = await params.onCreateSubtask!({
          prompt: String(args.prompt),
          title: typeof args.title === 'string' ? args.title : undefined,
          agent: typeof args.agent === 'string' ? args.agent : undefined,
        });
        return created.reused
          ? `NOT created: an equivalent subtask is already open — ${created.id} «${created.title}». Wait for it (check_subtasks) instead of starting a duplicate.`
          : `Created and queued subtask ${created.id} — "${created.title}".`;
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
          "Search the project's knowledge bases (large reference material: regulations, manuals, textbooks, saved web pages). Returns the best passages with their document id, passage number and source. `query`: a few specific words (the question's key terms — not a whole sentence) IN THE LANGUAGE OF THE DOCUMENTS (a Russian manual is found with Russian words; keyword search does not translate); `kb` (optional): search one base only; `limit` (default 6). Prefer it over guessing, and cite the source of a passage you rely on. If the results look thin, try synonyms or another language.",
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
        "Show pictures to the user IN THE CHAT — one picture, or an album of up to 10 (generated images, charts, screenshots, photos, video frames you extracted). `paths`: full paths of image files (png, jpg, webp, gif) in the task's attachments, the resource library or the workspace — or `task:<subtask id>/<file name>` for a picture one of your subtasks produced (shown from where it is, never copied); `caption`: one short line (what they are). They appear inline in the dashboard conversation and are sent as a photo / album to chat channels like Telegram. Use it whenever the result IS a picture — don't just name the file. Several related images go in ONE call (an album), not one call each.",
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

  if (params.onAskUser) {
    specs.push({
      name: 'ask_user',
      description:
        "Ask the HUMAN a question and wait for the answer. Use it when you need a decision or a missing fact that you cannot find yourself — instead of guessing, and instead of ending your run with a question. `question`: short and specific. `options`: 2–6 short answer choices shown as buttons (in the dashboard and in the chat channels); leave it out for an open question. `multiple` (default false): the person may tick SEVERAL options (\"which of these topics do you want?\") — the answer lists the chosen ones. `allow_text` (default true): the person may also type their own answer. `image`: a full path of a photo / video frame to show with the question (e.g. a frame from video_digest — \"is THIS the crack?\"). Returns the answer; if nobody answers in time you get a note saying so — then choose the safest default yourself or report the task as blocked. Don't ask what you can decide or check yourself, and ask one thing at a time.",
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
        "Look at a PHOTO or a VIDEO and answer a question about it, using the project's vision model (works for any agent, even one whose own model cannot see images). `path`: the full path of the file (a resource from the library or a file in the workspace) OR just the file name of an attachment of this task, exactly as the prompt lists it (e.g. \"IMG_4870.jpg\"). `question`: what you want to know — be specific (e.g. \"read the measurements on the tape\", \"is there mould on the wall\", \"what is wrong with this pronunciation exercise page\"). For a video it looks at frames spread over the whole clip (at most 8 are shown at once, evenly picked); `every_seconds` sets the step between frames (default: automatic). To look at the moments when the speaker POINTS at things (\"look here\", \"вот тут\"), set `pointing: true` (built-in list, Russian and English) and/or `phrases: [\"…\"]` (your own words); `at_seconds: [12, 40]` takes frames at exact times (read them from the timed transcript of video_digest). For a video you usually want video_digest first (it also gives you what was said).",
      shape: { path: z.string(), question: z.string(), every_seconds: z.number().optional(), at_seconds: z.array(z.number()).optional(), phrases: z.array(z.string()).optional(), pointing: z.boolean().optional() },
      handler: (args) =>
        params.onLookAt!({ path: String(args.path), question: String(args.question ?? ''), ...framePlan(args) }),
    });
  }

  if (params.onVideoDigest) {
    specs.push({
      name: 'video_digest',
      description:
        "Turn a VIDEO into something you can use: it returns frames spread over the clip (paths you can Read, or pass to look_at) and — when speech recognition is set up — a transcript of what was said. `path`: the full path of the video (library resource) or just the file name of a video attached to this task, as the prompt lists it. `every_seconds` (optional): take one frame every N seconds (min 1, up to 60 frames; default: about one per 10 s, 4–24 frames) — use a small step for fast action or a short clip, a large one for a long clip. The transcript is timestamped (`[0:12] …`). To get frames at the moments some words are said — the speaker says \"look here\" / \"смотри, вот тут\" — set `pointing: true` (built-in list, Russian and English) and/or `phrases: [\"…\"]`; each such frame is labelled with the words said. `at_seconds: [12, 40]` takes frames at exact times. A different frame plan re-takes the frames (the transcript is kept, so recognition is not paid for twice). The first call on a video takes a while (it is processed once and cached).",
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
          'Propose creating or replacing an agent. `name`: lowercase letters/digits/-/_. `content`: the COMPLETE agent file — frontmatter (description required; optional provider, model, skills, allowedTools, disallowedTools, mcp, `maxTurns: 80` (steps one run may take, 5–500; default 40 — give a lead that plans big work more), and `createTasks: true` to let a lead agent start new tasks in projects with the create_task tool — each one still approved by a person) followed by the system prompt. A human reviews the full content and must approve before anything is written; this call blocks until they decide. You cannot overwrite built-in agents.',
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
        name: 'packs_list',
        description:
          "List the ready-made content packs (e.g. English learning, Home renovation, Software team): what each contains (agents, skills, library notes, prepared schedules) and how much of it is already installed. Read-only. Offer the matching pack when the user describes such a project.",
        shape: {},
        handler: () => admin.packsList(),
      },
      {
        name: 'propose_pack_install',
        description:
          "Install a content pack by `name` (from packs_list): its agents, skills, starter notes in the resource library and prepared schedules (the schedules are created SWITCHED OFF — nothing runs until the user turns them on and picks a chat). Anything that already exists is left untouched, so it is safe to re-run. Ask the user's time zone and pass it as `timezone` (IANA, e.g. Europe/Kyiv) so the prepared schedules match. `project` (a project's slug, optional): the starter notes go into THAT project's library instead of the global one (agents and skills are always global). `reason` is required. A human reviews and must approve; this call blocks until they decide. Afterwards tell the user the \"next steps\" from the result (usually: fill in the profile note, choose a chat for the schedules).",
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
          "Add, change or delete a TEXT NOTE in a resource library — shared knowledge agents read (use it for things like a learner profile, house measurements, a style guide, a glossary). `action`: create | update | delete. create: `title`, `text` (Markdown), optional `description` (one line — shown to agents so they know when to read it), `tags`, `agents` (names of agents it is meant for; leave out for all), `project` (a project's slug: the note goes into THAT project's library and only its tasks see it; leave out for the global library every project shares). update: `id` (from resources_search) + the fields to change; `text` replaces the whole note. delete: `id`. Files and images are uploaded by the user in the dashboard (Resources) — you cannot create those. A human reviews and must approve; this call blocks until they decide. Search first (resources_search) to avoid duplicates.",
        shape: {
          action: z.enum(['create', 'update', 'delete']),
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
              action: args.action as 'create' | 'update' | 'delete',
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
          "Create, change or delete a chat channel. `action`: create | update | delete; `name` identifies it. create: `kind` \"telegram\" — the channel is created SWITCHED OFF and has no token yet; next call request_secret (target \"channel\", name = the channel name) so the user enters the BotFather token in a secure field (never in the chat) — it then switches on by itself. update: `enabled`, `defaultAgent` (an existing agent for tasks from this channel), `allowChatId` (let that chat control the platform — only for a chat id the user confirmed, usually one listed as waiting in channels_list), `removeChatId`. A chat that is allowed can create tasks and approve actions, so only allow the user's own chats. `reason` is required. A human reviews and must approve; this call blocks until they decide.",
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
        name: 'schedules_list',
        description:
          'List the recurring jobs (reminders and periodic tasks): name, when it runs (in words), kind, target chat/agent, next run, last result. Read-only.',
        shape: {},
        handler: () => admin.schedulesList(),
      },
      {
        name: 'propose_schedule',
        description:
          "Create, change or delete a recurring job. `action`: create | update | delete; `name` identifies it. For create/update: `cron` (5 fields: minute hour day-of-month month day-of-week, e.g. \"30 9 * * *\" = every day 09:30, \"0 18 * * 0\" = Sundays 18:00, \"0 8 * * 1-5\" = weekdays 08:00; not more often than every 5 minutes), `timezone` (IANA, e.g. Europe/Kyiv — ask the user, don't guess), `kind`: \"message\" (posts `text` to a chat — no model, free; use it for plain reminders) or \"task\" (starts a task with `text` as the prompt for `agentName` each time — uses model budget; its updates go to the chat; `taskMode`: \"same\" (default) = every run continues ONE task, so the agent remembers earlier runs, or \"new\" = every run starts a separate task), `channel` (channel NAME) + `chatId` (must already be an allowed chat of that channel — see channels_list), optional quiet hours `quietStart`/`quietEnd` (HH:MM, runs inside are skipped), optional `enabled`. `reason` is required. A human reviews and must approve; this call blocks until they decide. Schedules cannot be part of propose_batch — call this once per job.",
        shape: {
          action: z.enum(['create', 'update', 'delete']),
          name: z.string(),
          cron: z.string().optional(),
          timezone: z.string().optional(),
          kind: z.enum(['message', 'task']).optional(),
          text: z.string().optional(),
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
              kind: opt('kind') as 'message' | 'task' | undefined,
              text: typeof args.text === 'string' ? args.text : undefined,
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
          "Update this server to a newer release. `version` (e.g. 0.1.48) or omit it for the latest; `force: true` only if the user accepts that running tasks are interrupted (otherwise it refuses while tasks run). The server RESTARTS for a minute or two — you and the dashboard are unreachable meanwhile, so say so first and do not start other work. `reason` is required. A human reviews and must approve; this call blocks until they decide, then returns as soon as the update has started. The previous version is kept for a rollback (`aigentron rollback` on the server).",
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
          "Change the list of domain names this server answers to. `action`: add | remove | set (replace the whole list) | clear (accept any name again); `domains` (for add/remove/set): names like dev.example.com or *.example.com. localhost, IP addresses and single-word LAN names always work, whatever the list. Once the list is non-empty, OTHER public domain names stop working — make sure the user's own address stays on it. `reason` is required. A human reviews and must approve; this call blocks until they decide. PUBLIC_URL / listen address live in the server's .env — you cannot change them; point the user to `aigentron access`.",
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
          "Turn the server's own Cloudflare Access check on or off. `enabled`; `teamDomain` (yourteam.cloudflareaccess.com — Zero Trust → Settings → Team domain); `aud` (the Application Audience tag from the Access application's Overview page; optional if one is already saved — it is an identifier, not a secret, so it may be typed in chat). When on, a request under a real domain name must carry Cloudflare's signed token or it gets 403 (localhost, IPs and the local network are unaffected). The call first checks that Cloudflare answers for that team. `reason` is required. A human reviews and must approve; this call blocks until they decide.",
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
          "Propose starting a task for another agent on the user's behalf: `agentName` (an existing agent other than yourself), `prompt` (the full instruction — a complete brief, not a title), optional `title`, `reason`. It runs immediately after approval and spends that agent's provider budget. By default it starts as a SUBTASK of this conversation (it appears nested under this chat, and you are told when it finishes) — do not multiply top-level tasks. Pass `standalone: true` only for an independent, long-running job the person will follow on its own, or when this conversation is not the right owner of it. You get the task id back; check progress/results later with task_diagnose. Use it when the user asks you to get something done by an agent (e.g. 'ask the researcher to find…').",
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
        name: 'current_context',
        description:
          "Where the person is in the dashboard right now, and what is there: on a task page → that task's status, error, agent, runs, approvals, subtasks and last messages; on a project page → the project; elsewhere → the page's name. Call it when they say 'this task', 'here', 'this page', 'why did it fail' without an id. Read-only.",
        shape: {},
        handler: () => admin.currentContext(),
      },
      {
        name: 'metrics_report',
        description:
          "Numbers to CHECK a complaint or a setting against, as tables (read-only). `topic`: 'approvals' (how many approval cards, by reason / tool / most repeated command, per run, who decided, how long they waited, which tasks ask most), 'tasks' (outcomes, why they failed / stalled / hit the step limit / ended without a result, durations), 'agents' (per agent: runs, steps, failure rate, tokens, cost estimate, approvals per run), 'config' (the settings that shape behaviour: step limit, concurrency, approval timeout and repeat limit, project modes, per-agent limits and providers), 'system' (the machine right now: load per CPU, free memory, runs in flight, the limits that hold new runs back — for \"the server is overloaded\"). `days` (default 7, max 365); `project` (slug) and `agent` (name) narrow approvals / tasks / agents. Use it before proposing a change (\"how often do cards come from rm?\") and again after, to show whether it helped. Cost figures for subscription providers are estimates at API list prices, not charges.",
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
          'Token, request and estimated-cost usage per provider over the last N days (default 7, max 365) — the numbers behind the Stats page. Subscription-based providers (Codex/ChatGPT) record tokens but no cost.',
        shape: { days: z.number().optional() },
        handler: (args) => admin.usageReport({ days: typeof args.days === 'number' ? args.days : undefined }),
      },
      {
        name: 'request_secret',
        description:
          "Ask the user to enter an API key / token in a SECURE field (a card in the dashboard, a hidden prompt in the console) — the value goes straight to the server and you never see it. `target`: 'provider' (the key/token of the provider `name`), 'github_token' (the GitHub token in Settings) or 'channel' (the bot token of the channel `name`). On a phone/Telegram the user gets a one-time secure link instead of a card. `reason`: one line shown to the user. Blocks until they save or cancel; returns whether it was saved. NEVER ask the user to type a key in the chat — use this.",
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

  return specs;
}
