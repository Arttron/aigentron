import { analyzeShell, isMainRef, type ShellFacts } from './shell-guard';

// `URL` exists in every runtime this runs in (the server, the hook, the browser); the package is compiled without the DOM / node typings.
declare const URL: new (url: string, base?: string) => { protocol: string; hostname: string };
import { parseFrontmatter } from './frontmatter';
/**
 * DANGER CLASSIFIER — the single source of truth for what counts as a
 * "dangerous" tool call requiring human approval. Both the orchestrator and the
 * PreToolUse hook import this so they can never disagree.
 *
 * Philosophy: fail safe. We auto-allow only what we can positively recognize as
 * benign; anything matching a destructive/irreversible/outbound pattern is held
 * for approval. The list is intentionally conservative for a v1.
 */

/**
 * Identity of our in-process control-plane MCP server and its tools. Single
 * source of truth shared by the runner (which registers the server), the
 * classifier (which exempts it from the approval gate), the executor (which
 * whitelists the tools) and the MCP registry (which reserves the name). The
 * name is deliberately distinctive so a user-registered MCP server can't shadow
 * it or inherit its approval exemption.
 */
export const INTERNAL_MCP_SERVER = 'lds_internal';
/** Prefix of the fully-qualified tool names the SDK exposes (mcp__<server>__). */
export const INTERNAL_TOOL_PREFIX = `mcp__${INTERNAL_MCP_SERVER}__`;
export const REPORT_STATUS_TOOL = `${INTERNAL_TOOL_PREFIX}report_task_status`;
export const HEARTBEAT_TOOL = `${INTERNAL_TOOL_PREFIX}heartbeat`;
/** Lead-only decomposition tool: create + enqueue a subtask under this task. */
export const CREATE_SUBTASK_TOOL = `${INTERNAL_TOOL_PREFIX}create_subtask`;
/** Lead-only: check the status + latest result of this task's subtasks. */
/** A lead marks one of ITS subtasks done (accepts a finished / blocked / failed one as it is). */
/**
 * A lead agent (its file says `createTasks: true`) starts a task in ANOTHER or the same project (not a subtask of this one). Gated
 * like propose_task: a person approves each one on a card, and an equivalent open task is reused instead of duplicated.
 */
export const CREATE_TASK_TOOL = `${INTERNAL_TOOL_PREFIX}create_task`;
/**
 * An agent asks the orchestrator to push a LOCAL branch of its project's repository to the project's remote. The agent never holds
 * the credentials, so a `git push` from its shell cannot work; this is the way, and a person approves each push on a card.
 */
export const PUSH_BRANCH_TOOL = `${INTERNAL_TOOL_PREFIX}push_branch`;
/**
 * An agent asks the orchestrator to `git fetch` its project's remote with the project's credentials (a `git fetch` from its own shell cannot
 * authenticate). Read-only for the remote and for the agent's files (only remote-tracking refs move), so it needs no approval.
 */
export const FETCH_REMOTE_TOOL = `${INTERNAL_TOOL_PREFIX}fetch_remote`;
export const COMPLETE_SUBTASK_TOOL = `${INTERNAL_TOOL_PREFIX}complete_subtask`;
export const CHECK_SUBTASKS_TOOL = `${INTERNAL_TOOL_PREFIX}check_subtasks`;
/**
 * Raised by the orchestrator itself (not a tool an agent can call, hence no tool prefix) when a run that is still working reaches the ceiling of active time: a person decides
 * whether it may go on. Gated like the other internal tools that cost something; the approval card carries the time used and the extra asked for.
 */
export const EXTEND_RUN_TOOL = '__extend_run_time__';
/** Sentinel toolName for a "run out of steps — continue?" approval (not a real tool). */
export const CONTINUE_RUN_TOOL = '__continue_run__';
/** Schedule a delayed re-run of this task ("check back in N seconds"). */
export const SCHEDULE_CHECK_TOOL = `${INTERNAL_TOOL_PREFIX}schedule_check`;
/** Start (or reuse) an ephemeral dev server for this task's worktree, for preview. */
/** Read-only search over the project's resource library (notes/images/documents). Free for every agent. */
/** Photos and video: `look_at` (a vision model looks at a photo / video frames), `video_digest` (frames + transcript of a video). Read-only. */
/** Ask the human a question with answer buttons and wait for the answer. Not gated: the question itself is the human step. */
/** The current date and time (agents have no clock of their own). Read-only. */
/** Show pictures (single / album) in the chat. Read-only. */
export const SHOW_IMAGES_TOOL = `${INTERNAL_TOOL_PREFIX}show_images`;
/** The shared workspace (memory / work / deliverables): notes, saving results, listing files. Not gated. */
export const WORKSPACE_INFO_TOOL = `${INTERNAL_TOOL_PREFIX}workspace_info`;
export const WORKSPACE_NOTE_TOOL = `${INTERNAL_TOOL_PREFIX}workspace_note`;
export const WORKSPACE_SAVE_TOOL = `${INTERNAL_TOOL_PREFIX}workspace_save`;
export const WORKSPACE_FILES_TOOL = `${INTERNAL_TOOL_PREFIX}workspace_files`;
/** Read the text of an attachment / workspace / library file (md, txt, csv, json, html, PDF text layer, Word) — for agents without a file reader. Read-only. */
export const READ_DOCUMENT_TOOL = `${INTERNAL_TOOL_PREFIX}read_document`;
export const CURRENT_TIME_TOOL = `${INTERNAL_TOOL_PREFIX}current_time`;
/** Knowledge bases: search / read passages, list what exists, add a note (only to bases that allow it). Not gated. */
export const KB_LIST_TOOL = `${INTERNAL_TOOL_PREFIX}kb_list`;
export const KB_SEARCH_TOOL = `${INTERNAL_TOOL_PREFIX}kb_search`;
export const KB_READ_TOOL = `${INTERNAL_TOOL_PREFIX}kb_read`;
export const KB_ADD_TOOL = `${INTERNAL_TOOL_PREFIX}kb_add`;
export const ASK_USER_TOOL = `${INTERNAL_TOOL_PREFIX}ask_user`;
export const LOOK_AT_TOOL = `${INTERNAL_TOOL_PREFIX}look_at`;
export const VIDEO_DIGEST_TOOL = `${INTERNAL_TOOL_PREFIX}video_digest`;
export const RESOURCES_SEARCH_TOOL = `${INTERNAL_TOOL_PREFIX}resources_search`;
export const PREVIEW_TOOL = `${INTERNAL_TOOL_PREFIX}preview_worktree`;
/** Stop the task's preview dev server (once the screenshots are taken). Not gated. */
export const STOP_PREVIEW_TOOL = `${INTERNAL_TOOL_PREFIX}stop_preview`;
/**
 * Propose a write to agent/skills/learned/<name>.md (roadmap Phase 6 — skill
 * lifecycle). Unlike every other internal tool, this ONE is deliberately NOT
 * exempt from the approval gate below — it mutates a file every future agent
 * run reads as context, so a human must sign off, same as any other dangerous
 * write. Kept as an internal MCP tool (not the generic Write tool) because the
 * target lives outside any task's worktree.
 */
export const PROPOSE_LEARNED_SKILL_TOOL = `${INTERNAL_TOOL_PREFIX}propose_learned_skill`;

/**
 * Admin-agent write tools: create/change an agent definition (agent/agents/<name>.md)
 * or a custom skill. Gated like PROPOSE_LEARNED_SKILL_TOOL — an agent file decides
 * what a future run may do (prompt, tools, MCP), so a human signs off on the full
 * content. The read-only admin tools (catalog_list/catalog_get/agents_list) stay
 * under the blanket internal-tool exemption.
 */
export const PROPOSE_AGENT_TOOL = `${INTERNAL_TOOL_PREFIX}propose_agent`;
export const PROPOSE_SKILL_TOOL = `${INTERNAL_TOOL_PREFIX}propose_skill`;
export const CATALOG_LIST_TOOL = `${INTERNAL_TOOL_PREFIX}catalog_list`;
export const CATALOG_GET_TOOL = `${INTERNAL_TOOL_PREFIX}catalog_get`;
export const AGENTS_LIST_TOOL = `${INTERNAL_TOOL_PREFIX}agents_list`;
export const AGENT_GET_TOOL = `${INTERNAL_TOOL_PREFIX}agent_get`;
export const TASK_DIAGNOSE_TOOL = `${INTERNAL_TOOL_PREFIX}task_diagnose`;
/** Where the person is in the dashboard (read-only): their current task / project / page. */
export const CURRENT_CONTEXT_TOOL = `${INTERNAL_TOOL_PREFIX}current_context`;
/** Read-only: approvals / task outcomes / per-agent numbers / the settings that drive them, as tables. */
export const METRICS_REPORT_TOOL = `${INTERNAL_TOOL_PREFIX}metrics_report`;
export const USAGE_REPORT_TOOL = `${INTERNAL_TOOL_PREFIX}usage_report`;
/** Platform management by the admin agent: reading tasks is free; every mutation is a gated proposal. */
export const TASKS_LIST_TOOL = `${INTERNAL_TOOL_PREFIX}tasks_list`;
export const PROPOSE_TASK_ACTION_TOOL = `${INTERNAL_TOOL_PREFIX}propose_task_action`;
export const PROPOSE_AGENT_DELETE_TOOL = `${INTERNAL_TOOL_PREFIX}propose_agent_delete`;
/** Providers: listing/testing is free (never exposes secrets); create/update is a gated proposal (no secret in it). */
export const PROVIDERS_LIST_TOOL = `${INTERNAL_TOOL_PREFIX}providers_list`;
export const PROVIDER_TEST_TOOL = `${INTERNAL_TOOL_PREFIX}provider_test`;
export const PROPOSE_PROVIDER_TOOL = `${INTERNAL_TOOL_PREFIX}propose_provider`;
/**
 * The admin asks the human to type an API key/token into a secure card (dashboard) or hidden prompt (console). It reuses
 * the approval pipeline for the card/blocking, but the value is submitted to a dedicated endpoint and never appears in the
 * tool input, the transcript or the model context. Plain "Approve" is refused for it (see ApprovalsService.decide).
 */
/** Narrow, approved changes to a few platform settings, and reverting earlier admin changes. */
export const PROPOSE_SETTINGS_TOOL = `${INTERNAL_TOOL_PREFIX}propose_settings`;
/** Start a task for another agent on the user's behalf (it uses the provider's budget — approval required). */
export const PROPOSE_TASK_TOOL = `${INTERNAL_TOOL_PREFIX}propose_task`;
/**
 * Several related admin changes behind ONE approval card (agents, skills, providers, settings, task starts, task actions,
 * agent deletions). Validated as a whole before the card is shown; applied in order through the same code paths as the
 * single proposals, each journaled separately.
 */
export const PROPOSE_BATCH_TOOL = `${INTERNAL_TOOL_PREFIX}propose_batch`;
export const PROPOSE_UNDO_TOOL = `${INTERNAL_TOOL_PREFIX}propose_undo`;
export const ADMIN_HISTORY_TOOL = `${INTERNAL_TOOL_PREFIX}admin_history`;
export const REQUEST_SECRET_TOOL = `${INTERNAL_TOOL_PREFIX}request_secret`;
/** Housekeeping: reading the disk-usage report is free; deleting run folders / worktrees / branches is a gated proposal. */
export const MAINTENANCE_REPORT_TOOL = `${INTERNAL_TOOL_PREFIX}maintenance_report`;
export const PROPOSE_CLEANUP_TOOL = `${INTERNAL_TOOL_PREFIX}propose_cleanup`;
/** Recurring jobs (reminders / periodic tasks): listing is free; create/change/delete is a gated proposal. */
export const SCHEDULES_LIST_TOOL = `${INTERNAL_TOOL_PREFIX}schedules_list`;
export const PROPOSE_SCHEDULE_TOOL = `${INTERNAL_TOOL_PREFIX}propose_schedule`;
/** Where the server answers: reading the status is free; changing the allowed domains / Cloudflare Access is a gated proposal. */
/** Updating the server itself: reading the status is free; starting an update is a gated proposal (the server restarts). */
export const UPDATE_STATUS_TOOL = `${INTERNAL_TOOL_PREFIX}update_status`;
export const PROPOSE_UPDATE_TOOL = `${INTERNAL_TOOL_PREFIX}propose_update`;
export const ACCESS_STATUS_TOOL = `${INTERNAL_TOOL_PREFIX}access_status`;
export const PROPOSE_ALLOWED_DOMAINS_TOOL = `${INTERNAL_TOOL_PREFIX}propose_allowed_domains`;
export const PROPOSE_CLOUDFLARE_ACCESS_TOOL = `${INTERNAL_TOOL_PREFIX}propose_cloudflare_access`;
/** Chat channels (Telegram): listing (with connectivity + chats waiting to be allowed) is free; create/change/delete is gated. The bot token is entered through request_secret, never here. */
/** The admin writes/changes/deletes a text note in the project's resource library (approval). */
export const PROPOSE_RESOURCE_TOOL = `${INTERNAL_TOOL_PREFIX}propose_resource`;
/** Content packs (ready-made sets of agents, skills, library notes and switched-off schedules): listing is free; installing is a gated proposal. */
export const PACKS_LIST_TOOL = `${INTERNAL_TOOL_PREFIX}packs_list`;
export const PROPOSE_PACK_INSTALL_TOOL = `${INTERNAL_TOOL_PREFIX}propose_pack_install`;
export const CHANNELS_LIST_TOOL = `${INTERNAL_TOOL_PREFIX}channels_list`;
export const PROPOSE_CHANNEL_TOOL = `${INTERNAL_TOOL_PREFIX}propose_channel`;

/** Tiny stable string hash (two FNV-1a passes, 64 bits, hex) — keeps approval summaries distinct per content. */
function shortHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** The frontmatter lines that decide what an agent may do — surfaced in the approval reason. */
function agentPowers(content: string): string {
  const fm = parseFrontmatter(content);
  if (!fm) return 'no frontmatter';
  const keys = ['provider', 'model', 'allowedTools', 'disallowedTools', 'mcp', 'skills'];
  const found = fm.lines.filter((l) => keys.some((k) => l.startsWith(`${k}:`)));
  return found.length ? found.join(' | ') : 'default tools, no MCP';
}

export interface ClassifyOptions {
  /**
   * Absolute path of the worktree the agent is confined to. When provided,
   * file writes resolving outside it are flagged as dangerous.
   */
  workspaceRoot?: string;
  /**
   * More absolute folders the agent may write to besides `workspaceRoot` (the shared workspace:
   * memory / work / deliverables). A write is "outside" only if it is inside none of them.
   */
  extraWriteRoots?: readonly string[];
  /**
   * Operator-declared read-only MCP tools, per server name: `{ research: ['*'] }` or
   * `{ docs: ['search', 'fetch'] }` (`'*'` = every tool of that server). Extends the built-in
   * knowledge about code-intel/github/playwright; anything else on an MCP server stays gated.
   * Comes from the `readOnlyTools` key of an MCP server's config (see McpService).
   */
  readOnlyMcp?: Record<string, readonly string[]>;
  /**
   * What the task's browser is looking at, as far as the orchestrator has seen (see `browserPageAfter`). On a `blank` or `local` page the browser's own
   * interactions (click, type, fill a form, press a key …) need no approval — the page is the project's own dev server and nothing leaves the machine; on an
   * `external` page (a person approved the visit) they stay gated. Unset (callers that do not track it): always gated.
   */
  browserPage?: BrowserPage;
  /**
   * Values of environment variables the agent's shell has (`LDS_ATTACHMENTS_DIR`, `TMPDIR`): `$NAME` / `${NAME}` in a shell command is read as that path, so
   * `cp x.png $LDS_ATTACHMENTS_DIR/` is judged by where it really writes instead of counting as «a path that cannot be known».
   */
  knownVars?: Readonly<Record<string, string>>;
}

/** Variables whose value may be substituted (the orchestrator sets them; nothing the agent controls). */
export const KNOWN_VAR_NAMES = ['LDS_ATTACHMENTS_DIR', 'TMPDIR'] as const;

/** `$NAME` / `${NAME}` → its value, for the known variables whose value is a plain absolute path (no spaces, quotes or shell characters). */
export function expandKnownVars(command: string, vars?: Readonly<Record<string, string>>): string {
  if (!vars) return command;
  let out = command;
  for (const name of KNOWN_VAR_NAMES) {
    const value = vars[name]?.replace(/\/+$/, '');
    if (!value || !/^\/[\w./@+-]+$/.test(value)) continue;
    out = out.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`, 'g'), value);
  }
  return out;
}

export type BrowserPage = 'blank' | 'local' | 'external';

/**
 * Where the browser is after this call. A navigation moves it (a local dev address → `local`, anything else → `external`); a path on the page it is already
 * on leaves it where it was. Going back, or switching / opening / closing tabs, puts it on a page nobody has looked at: `external` (= not known to be local)
 * until the next navigation to a local address. Every other call leaves it as it was.
 */
export function browserPageAfter(toolName: string, toolInput: Record<string, unknown>, current: BrowserPage = 'blank'): BrowserPage {
  const m = /^mcp__playwright(?:-proxy)?__(browser_[a-z_]+)$/i.exec(toolName);
  if (!m) return current;
  const tool = m[1]!.toLowerCase();
  if (tool === 'browser_navigate_back') return 'external';
  if (tool === 'browser_tabs') return typeof toolInput.action === 'string' && toolInput.action.toLowerCase() === 'list' ? current : 'external';
  if (tool !== 'browser_navigate') return current;
  const kind = classifyNavUrl(typeof toolInput.url === 'string' ? toolInput.url : '');
  return kind === 'relative' ? current : kind;
}

export interface DangerVerdict {
  dangerous: boolean;
  /** Human-readable description of the action (shown in the approvals UI). */
  summary: string;
  /** Why it was flagged. Empty when not dangerous. */
  reason: string;
  /** Never waved through, not even in the no-approvals mode (credentials, protected files). */
  hard?: boolean;
  /**
   * The kind of action that is still asked about in the no-approvals mode (everything else dangerous goes ahead there): a `merge`, an action on the
   * `main-branch` (main / master), or something outside the working `outside` directory.
   */
  guard?: Guard;
}

export type Guard = 'merge' | 'main-branch' | 'outside';

const GUARD_LABEL: Record<Guard, string> = {
  merge: 'a merge',
  'main-branch': 'an action on the main / master branch',
  outside: 'an action outside the working directory',
};

/** Is a path written by a command beyond the agent's write roots? A path that cannot be known (`$HOME/x`, `~/x`, after a `cd` into the unknown) counts as beyond. */
function mutatesOutside(m: ShellFacts['mutated'][number], opts: ClassifyOptions): boolean {
  if (!opts.workspaceRoot) return false;
  if (m.dynamic) return true;
  if (m.path === '/' || m.path === '/*') return true;
  if (!m.path.startsWith('/') && m.cwd === null) return true;
  return !insideWriteRoots(normalize(m.path.startsWith('/') ? m.path : `${(m.cwd ?? opts.workspaceRoot).replace(/\/$/, '')}/${m.path}`), opts);
}

/** Does a shell command write / move / delete something outside the agent's write roots? */
export function shellActsOutside(command: string, opts: ClassifyOptions): boolean {
  return analyzeShell(command, opts.workspaceRoot ?? null).mutated.some((m) => mutatesOutside(m, opts));
}

/** The merge / main-branch / outside guard a shell command falls under, if any, and whether it writes a protected or credentials file. */
function shellGuard(command: string, opts: ClassifyOptions): { guard: Guard; reason: string } | null {
  const facts = analyzeShell(command, opts.workspaceRoot ?? null);
  if (facts.mainBranch) return { guard: 'main-branch', reason: GUARD_LABEL['main-branch'] };
  if (facts.merge) return { guard: 'merge', reason: GUARD_LABEL.merge };
  if (facts.mutated.some((m) => mutatesOutside(m, opts))) return { guard: 'outside', reason: GUARD_LABEL.outside };
  return null;
}

/** The first protected / credentials file a shell command writes, moves or deletes (relative paths are read against the directory they run in). */
function shellProtectedTarget(command: string, opts: ClassifyOptions): { path: string; secret: boolean } | null {
  for (const m of analyzeShell(command, opts.workspaceRoot ?? null).mutated) {
    if (m.dynamic) continue;
    const abs = normalize(m.path.startsWith('/') ? m.path : `${(m.cwd ?? opts.workspaceRoot ?? '').replace(/\/$/, '')}/${m.path}`);
    if (isSecretPath(abs)) return { path: abs, secret: true };
    if (isProtectedPath(abs) || abs.split('/').some((seg) => seg === '.git' || seg === '.github')) return { path: abs, secret: false };
  }
  return null;
}

/** Shell command patterns that are destructive, irreversible, or outbound. */
const DANGEROUS_SHELL_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string; hard?: boolean }> = [
  {
    re: /\/proc\/[^\s/]+\/environ|\.codex-home|codex-home\/|(^|[\s/])auth\.json\b|\.git\/config\b|(^|[\s/"'=])\.env(?!\.example)\b|\.credentials\.json|(^|[\s/"'=~])\.claude\.json|\/\.(ssh|aws|gnupg|docker|kube)\/|\/run\/secrets\/|\/(workspace|data)\/secrets\b/,
    reason: 'touches a credentials file (env/tokens/secrets)',
    hard: true,
  },
  // The model's credentials are in the agent's own environment: listing it, or putting a variable named like a secret into a command, is how they leak.
  {
    re: /(^|[\s;&|(`"'])printenv\b|(^|[\s;&|(`"'])env\s*($|[|;&>)`"'])|\bexport\s+-p\b|\bdeclare\s+-[a-z]*x\b|\bcompgen\s+-e\b|\$\{?[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_?KEY|OAUTH|CREDENTIALS?|PRIVATE_?KEY)[A-Z0-9_]*/,
    reason: 'reads secrets from the environment (the model keys / hook secret live there)',
    hard: true,
  },
  // `git config` that makes git run something (hooks, pagers, editors, credential helpers, aliases) is a way to run code later, outside the card.
  {
    re: /\bgit\b[^\n;&|]*\bconfig\b[^\n;&|]*\b(core\.(hooksPath|sshCommand|fsmonitor|editor|pager|askPass)|credential\.|alias\.|url\.[^\s]*insteadOf|include(If)?\.path|gpg\.program|diff\.external)/i,
    reason: 'git config that makes git run a program (hooks, credential helper, alias)',
    hard: true,
  },
  // The sign-in password lives in a `secrets` directory as auth.json: also catch the ways around a literal path
  // (cd into it, globs like au*.json, find -name auth*, the make target that removes the password).
  {
    re: /\bcd\s+[^\n;&|]*\bsecrets\b|(^|[\s/"'])secrets\/|-i?name\s+["']?[^\s"']*auth|(^|[\s/"'=])au[*?[]|\bauth[\w.-]*[*?[]|\bmake\s+(set|reset)-password\b/,
    reason: 'touches the credentials directory / sign-in password',
    hard: true,
  },
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, reason: 'recursive force remove (rm -rf)' },
  { re: /\brm\s+-[a-z]*r[a-z]*\b/i, reason: 'recursive remove (rm -r)' },
  { re: /\bgit\s+push\b/i, reason: 'git push (publishes commits to a remote)' },
  // `--force` anywhere; the short `-f` only where it is destructive (git / docker / kubectl / helm / rm), not `tail -f`, `grep -f`, `curl -f`, `cp -f`.
  { re: /--force\b|\b(git|docker|kubectl|helm|rm)\b[^\n;&|]*\s-[a-z]*f\b/i, reason: 'force flag' },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: 'git hard reset (discards work)' },
  { re: /\bgit\s+clean\b/i, reason: 'git clean (deletes untracked files)' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, reason: 'package publish' },
  { re: /\bdocker\s+push\b/i, reason: 'docker image push' },
  { re: /\b(terraform|tofu)\s+(destroy|apply)\b/i, reason: 'infrastructure mutation' },
  { re: /\bkubectl\s+(delete|apply|drain|cordon)\b/i, reason: 'kubernetes cluster mutation' },
  // Outbound network — broadened beyond `curl -X`.
  { re: /\bcurl\b[^\n]*\s(-d|--data\S*|--upload-file|-T|-F|--form|-X|--request)\b/i, reason: 'outbound curl request/upload' },
  { re: /\bwget\b[^\n]*--(post-data|post-file|method)\b/i, reason: 'outbound wget post' },
  { re: /\b(curl|wget)\b[^\n]*(\$\{?\w|\$\(|`)/i, reason: 'outbound request with a value taken from the shell (a variable or command output in the address)' },
  { re: /\b(curl|wget|fetch)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(ba|z|da|k)?sh\s+-c\s+["']?\$\(\s*(curl|wget)\b/i, reason: 'downloads and executes remote code (curl | sh)' },
  { re: /\b(nc|ncat|netcat|socat)\b/i, reason: 'raw network (netcat/socat)' },
  { re: /\/dev\/(tcp|udp)\//i, reason: 'bash /dev/tcp network socket' },
  { re: /\b(python3?|node|deno|bun|ruby|php|perl)\b[^\n]*(\b(urllib|requests|httpx|http|https|socket|fetch|net\/http|Net::HTTP|file_get_contents|child_process|require|import)\b|https?:\/\/)/i, reason: 'inline network/exec from an interpreter' },
  { re: /\bsudo\b/i, reason: 'privilege escalation (sudo)' },
  { re: /\bchmod\s+-R?\s*0?777\b/i, reason: 'world-writable permissions' },
  { re: /\bmkfs\b|\bdd\s+if=/i, reason: 'raw disk / filesystem operation' },
  { re: />\s*\/dev\/(sd|nvme|disk)/i, reason: 'write to a raw block device' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'host power state change' },
  { re: /:\(\)\s*\{.*\};:/, reason: 'fork bomb' },
  { re: /\b(kill|pkill|killall)\s+-9\b/i, reason: 'forced process kill' },
];

// Lowercased — toolName is normalized before lookup.
const SHELL_TOOLS = new Set(['bash', 'shell', 'sh', 'zsh', 'terminal', 'computer', 'computer_use']);
const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'str_replace_based_edit_tool',
  'str_replace_editor',
  'applypatch',
]);

// ---------------------------------------------------------------------------
// Read-only MCP allowlist. `mcp__*` tools are default-deny (external servers),
// but pure navigation/read tools carry no mutation or exfiltration risk and
// would otherwise force an approval prompt on every step of code navigation or
// UI preview. Allowlists are explicit per server (never a denylist) so a
// dangerous tool a server also exposes — e.g. Serena's execute_shell_command —
// is never auto-allowed just because its server is trusted for reads.
// ---------------------------------------------------------------------------

/** Serena (code-intel) — semantic read/navigation only; writes stay gated. */
const CODE_INTEL_READONLY = new Set([
  'find_symbol',
  'find_referencing_symbols',
  'get_symbols_overview',
  'search_for_pattern',
  'read_file',
  'list_dir',
  'find_file',
  'read_memory',
  'list_memories',
  'get_current_config',
]);

/** Playwright — read/capture tools; page-mutating interactions stay gated. */
const PLAYWRIGHT_READONLY = new Set([
  'browser_navigate_back',
  'browser_resize',
  'browser_take_screenshot',
  'browser_snapshot',
  'browser_console_messages',
  'browser_network_requests',
  'browser_wait_for',
  'browser_tab_list',
  'browser_tabs',
]);

/**
 * Page interactions of the Playwright browser. Free on the project's own (local) pages, gated on external ones. Not in the list, so always gated:
 * `browser_evaluate` / `browser_run_code` (arbitrary script: can post anything anywhere), `browser_file_upload` (reads files of the browser machine), `browser_install`.
 */
const PLAYWRIGHT_LOCAL_INTERACTIONS = new Set([
  'browser_click',
  'browser_hover',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
  'browser_select_option',
  'browser_drag',
  'browser_handle_dialog',
  'browser_close',
  'browser_mouse_move_xy',
  'browser_mouse_click_xy',
  'browser_mouse_drag_xy',
  'browser_mouse_down',
  'browser_mouse_up',
]);

/** Where an address leads, read the way the browser reads it (tabs and newlines dropped, `\` as `/`, scheme-relative `//host` is a host). */
export function classifyNavUrl(raw: string): 'blank' | 'relative' | 'local' | 'external' {
  const cleaned = raw.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\r\n]/g, '').replace(/\\/g, '/');
  if (!cleaned) return 'relative';
  if (cleaned.toLowerCase() === 'about:blank') return 'blank';
  let u: { protocol: string; hostname: string };
  try {
    u = new URL(cleaned, 'http://relative.invalid/');
  } catch {
    return 'external'; // not an address the browser can read: not ours to wave through
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'external';
  if (u.hostname === 'relative.invalid') return 'relative'; // a path on the page it is already on
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return LOCAL_HOSTS.has(host) ? 'local' : 'external';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal', 'dashboard', 'orchestrator', 'project-dev', 'playwright-mcp']);

/** Hosts a browser may navigate to without approval (local dev only). Anything else is gated so navigation can't become an outbound-exfil channel. */
function isLocalNavUrl(url: string): boolean {
  const k = classifyNavUrl(url);
  return k === 'relative' || k === 'local' || k === 'blank';
}

/**
 * A browser must never be pointed at local files or browser-internal pages (file:///proc/self/environ, chrome://…): that is how a page
 * could read secrets of the browser container. Refused outright — no approval card can make it acceptable. Returns the reason, or null.
 */
export function forbiddenBrowserNavigation(toolName: string, toolInput: Record<string, unknown>): string | null {
  const m = /^mcp__playwright(?:-proxy)?__browser_navigate$/i.exec(toolName);
  if (!m) return null;
  const url = typeof toolInput.url === 'string' ? toolInput.url.trim() : '';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (!scheme || scheme === 'http' || scheme === 'https') return null;
  if (url.toLowerCase() === 'about:blank') return null;
  return `Refused: the browser may only open http(s) addresses (not ${scheme}:). Local files and browser pages are off limits.`;
}

/** True if an `mcp__<server>__<tool>` call is a safe read-only/navigation op. */
function isReadOnlyMcpTool(
  name: string,
  toolInput: Record<string, unknown>,
  declared?: Record<string, readonly string[]>,
  browserPage?: BrowserPage,
): boolean {
  const parts = name.split('__'); // ['mcp', '<server>', '<tool>...']
  if (parts.length < 3) return false;
  const server = parts[1]!;
  const tool = parts.slice(2).join('__');
  // Operator-declared read-only tools (never for playwright's navigation, which has its own URL rule).
  const allow = declared?.[server];
  if (allow && server !== 'playwright' && server !== 'playwright-proxy' && (allow.includes('*') || allow.includes(tool))) return true;
  switch (server) {
    case 'code-intel':
      return CODE_INTEL_READONLY.has(tool);
    case 'github':
      // GitHub MCP read verbs, in both `verb_noun` (get_me, list_commits) and the
      // remote server's toolset `noun_verb` naming (actions_list, repos_get,
      // pull_requests_get, actions_download_*). Mutating verbs (create/update/
      // merge/push/delete/run/rerun/cancel/dispatch) stay gated. The server is
      // also configured read-only, so write tools aren't even exposed.
      // a read verb — but `mark_all_notifications_read`, `set_…`, `update_…` and the like end in one and write
      return !/^(mark|set|update|create|delete|add|remove|merge|push|dismiss|star|unstar|fork|run|rerun|cancel|dispatch|assign|close|reopen|lock|unlock|enable|disable|archive|transfer)_/i.test(tool) && /(^|_)(get|list|search|read|download)(_|$)/i.test(tool);
    case 'playwright':
    case 'playwright-proxy': // the same browser behind a proxy — same rules (non-local navigation stays gated)
      if (tool === 'browser_navigate') {
        return isLocalNavUrl(typeof toolInput.url === 'string' ? toolInput.url : '');
      }
      if (PLAYWRIGHT_READONLY.has(tool)) return true;
      return (browserPage === 'local' || browserPage === 'blank') && PLAYWRIGHT_LOCAL_INTERACTIONS.has(tool);
    default:
      return false; // unknown server → gated (e.g. postgres query: can't tell read from write)
  }
}

/** Files the agent must not write without approval (prompt/CI poisoning). */
function isProtectedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    /(^|\/)soul\.md$/i.test(path) ||
    // Fleet definition: agent role files and human-authored core skills are
    // immutable to agents (learned/ skills stay writable behind approval).
    lower.includes('/agent/agents/') ||
    lower.includes('/agent/skills/core/') ||
    // Admin journal/snapshots drive `propose_undo`; builtin/catalog are shipped definitions.
    lower.endsWith('/admin-audit.jsonl') ||
    lower.includes('/.snapshots/') ||
    lower.includes('/agent/builtin/') ||
    lower.includes('/agent/catalog/') ||
    lower.includes('/.github/') ||
    lower.includes('/.git/') ||
    lower.endsWith('/.lds') ||
    lower.includes('/.lds/')
  );
}

/**
 * Files that hold credentials: reading them can leak tokens into the model provider's
 * context (or out through any network tool). Reads of these require approval, for every agent.
 */
const SECRET_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /^\/proc\/[^/]+\/(environ|cmdline|maps|mem)$/, // process environments of the orchestrator & friends
  /(^|\/)\.codex-home(\/|$)/, // shared Codex sign-in
  /(^|\/)codex-home\//, // per-run Codex homes (auth.json copies)
  /(^|\/)auth\.json$/,
  /(^|\/)\.git\/config$/, // repo credentials (http.extraHeader token)
  /(^|\/)\.env(\.(?!example$)[\w.-]+)?$/, // .env, .env.local, … (not .env.example)
  /(^|\/)\.(ssh|aws|gnupg|docker|kube)(\/|$)/,
  /(^|\/)\.claude(\/|\.json$)/, // Claude Code credentials/config
  /^\/run\/secrets\//,
  /^\/(workspace|data)\/secrets(\/|$)/, // the platform's own secrets dir (shared Codex sign-in, …)
];

function isSecretPath(path: string): boolean {
  const n = normalize(path);
  return SECRET_PATH_PATTERNS.some((re) => re.test(n));
}

/** A path as typed → absolute: relative ones are read against the working directory (the project root), `..` resolved. */
function absolutePath(p: string, opts: ClassifyOptions): string {
  return normalize(p.startsWith('/') ? p : `${(opts.workspaceRoot ?? '').replace(/\/$/, '')}/${p}`);
}

function extractCommand(toolInput: Record<string, unknown>): string {
  const cmd = toolInput.command ?? toolInput.cmd ?? toolInput.script;
  return typeof cmd === 'string' ? cmd : '';
}

function extractPath(toolInput: Record<string, unknown>): string {
  const p = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path;
  return typeof p === 'string' ? p : '';
}

/** Normalize a path for prefix comparison (no fs access — pure string logic). */
function normalize(p: string): string {
  const segments: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') segments.pop();
    else segments.push(seg);
  }
  return (p.startsWith('/') ? '/' : '') + segments.join('/');
}

/** Scratch folders every run may use freely (build output, downloads, test fixtures): never a reason for a card. */
export const SCRATCH_ROOTS: readonly string[] = ['/tmp', '/var/tmp', '/private/tmp'];

function isInside(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/** The reasons of the shell rules that a plain `rm` inside the agent's own write roots does not trigger. */
const RM_REASONS = new Set(['recursive force remove (rm -rf)', 'recursive remove (rm -r)', 'force flag']);

/**
 * `rm [-rfivdR] path…` as ONE simple command whose every target is a real path (no `~`, no `$`, no `..` that leaves the roots) strictly
 * INSIDE the agent's own write roots or the scratch folders (/tmp) — never a root itself, never a protected or credentials path. Plain quotes
 * (without spaces inside) and a glob BELOW a named folder (`dist/*`, `/tmp/build-*`) are fine; a glob that spans a whole root (`*`) is not.
 * Clearing out its own folders is routine; the card is kept for anything that could reach beyond them.
 */
export function isSafeRmInRoots(command: string, opts: ClassifyOptions): boolean {
  if (!opts.workspaceRoot) return false;
  const c = command.trim();
  if (/[;&|<>`$()\\~{}[\]]/.test(c)) return false;
  if (/(["'])[^"']*\s[^"']*\1/.test(c)) return false; // a name with a space: not a simple path list
  const tokens = c.replace(/["']/g, '').split(/\s+/);
  if (tokens[0] !== 'rm') return false;
  let i = 1;
  while (i < tokens.length && /^-[rRfivd]+$/.test(tokens[i]!)) i++;
  const targets = tokens.slice(i);
  if (!targets.length || targets.some((t) => t.startsWith('-'))) return false;
  const roots = [opts.workspaceRoot, ...(opts.extraWriteRoots ?? []), ...SCRATCH_ROOTS].filter(Boolean).map((r) => normalize(r));
  return targets.every((t) => {
    const glob = /[*?]/.test(t);
    // a glob is judged by the folder it sits in: that folder must itself be strictly inside a root
    const lit = glob ? t.slice(0, Math.max(0, t.search(/[*?]/))).replace(/[^/]*$/, '') : t;
    const abs = normalize(lit.startsWith('/') ? lit : `${opts.workspaceRoot!.replace(/\/$/, '')}/${lit}`);
    if (isSecretPath(abs) || isProtectedPath(abs) || abs.split('/').some((seg) => seg === '.git' || seg === '.github')) return false;
    if (glob && /(^|\/)\.\.(\/|$)/.test(t)) return false;
    // `build-*` right in a root names its files by a prefix: fine. A bare `*` (or `*.log`) in a root spans the whole root: no.
    const globAt = t.search(/[*?]/);
    const named = glob && !t.slice(globAt).includes('/') && t.slice(0, globAt).length > 0 && !t.slice(0, globAt).endsWith('/');
    if (named) return roots.some((r) => isInside(abs, r));
    return roots.some((r) => abs !== r && isInside(abs, r)) && !roots.includes(abs);
  });
}

/** Inside the write boundary: the task root or any extra write root. */
function insideWriteRoots(absolute: string, opts: ClassifyOptions): boolean {
  if (!opts.workspaceRoot) return true;
  return isInside(absolute, opts.workspaceRoot) || (opts.extraWriteRoots ?? []).some((r) => r && isInside(absolute, r)) || SCRATCH_ROOTS.some((r) => isInside(absolute, r));
}

/**
 * Classify a single tool call. Pure and synchronous so it can run inside the
 * blocking hook with zero dependencies.
 */
export function classifyToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  opts: ClassifyOptions = {},
): DangerVerdict {
  const name = toolName.toLowerCase();

  // propose_learned_skill is the one internal tool that IS gated — see its
  // definition above. Checked before the blanket exemption below.
  if (name === PROPOSE_LEARNED_SKILL_TOOL.toLowerCase()) {
    const skillName = typeof toolInput.name === 'string' ? toolInput.name : '?';
    return {
      dangerous: true,
      summary: `propose_learned_skill ${skillName}`,
      reason: 'agent proposing a write to a learned-skill file (agent/skills/learned/)',
    };
  }

  if (name === PROPOSE_TASK_ACTION_TOOL.toLowerCase()) {
    const action = typeof toolInput.action === 'string' ? toolInput.action : '?';
    const ids = Array.isArray(toolInput.taskIds) ? toolInput.taskIds.map(String) : [];
    return {
      dangerous: true,
      // Hash of the exact id set: a different selection is a different approval.
      summary: `propose_task_action ${action} ${ids.length} task(s) #${shortHash([...ids].sort().join(','))}`,
      reason: `admin agent proposing to ${action} ${ids.length} task(s)${typeof toolInput.reason === 'string' && toolInput.reason ? ` — ${toolInput.reason.slice(0, 200)}` : ''}`,
    };
  }
  if (name === PROPOSE_SETTINGS_TOOL.toLowerCase()) {
    const ch = (toolInput.changes && typeof toolInput.changes === 'object' ? toolInput.changes : {}) as Record<string, unknown>;
    const keys = Object.keys(ch);
    const show = keys.map((k) => `${k}=${typeof ch[k] === 'string' ? JSON.stringify(String(ch[k]).slice(0, 60)) : String(ch[k])}`).join(', ');
    return {
      dangerous: true,
      summary: `propose_settings ${keys.join(',') || '(none)'} #${shortHash(JSON.stringify(ch))}`,
      reason: `admin agent proposing to change platform settings: ${show}${typeof toolInput.reason === 'string' && toolInput.reason ? ` — ${toolInput.reason.slice(0, 160)}` : ''}`,
    };
  }
  if (name === PUSH_BRANCH_TOOL.toLowerCase()) {
    const branch = typeof toolInput.branch === 'string' ? toolInput.branch : '?';
    const to = typeof toolInput.to === 'string' && toolInput.to ? toolInput.to : branch;
    const onMain = /^(main|master)$/i.test(branch) || /^(main|master)$/i.test(to);
    return {
      dangerous: true,
      ...(onMain ? { guard: 'main-branch' as const } : {}),
      summary: `push_branch ${branch} → origin/${to} #${shortHash(`${branch}\n${to}`)}`,
      reason: `agent proposing to PUBLISH the local branch "${branch}" to the project's remote as "${to}" (publishes commits to a remote; no force)${typeof toolInput.reason === 'string' && toolInput.reason ? ` — why: ${toolInput.reason.slice(0, 200)}` : ''}`,
    };
  }
  if (name === CREATE_TASK_TOOL.toLowerCase()) {
    const project = typeof toolInput.project === 'string' ? toolInput.project : '?';
    const agent = typeof toolInput.agent === 'string' && toolInput.agent ? toolInput.agent : 'the project default';
    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
    return {
      dangerous: true,
      summary: `create_task [${project}] → ${agent} #${shortHash(`${project}\n${agent}\n${prompt}`)}`,
      reason: `agent proposing to START a new task in project "${project}" for ${agent} (runs immediately, uses that agent's provider)${typeof toolInput.reason === 'string' && toolInput.reason ? ` — why: ${toolInput.reason.slice(0, 200)}` : ''}: ${prompt.replace(/\s+/g, ' ').slice(0, 160)}`,
    };
  }
  if (name === EXTEND_RUN_TOOL.toLowerCase()) {
    const n = (k: string) => (typeof toolInput[k] === 'number' ? (toolInput[k] as number) : 0);
    return {
      dangerous: true,
      summary: `extend_run_time +${n('extraMin')} min (after ${n('usedMin')} min) #${shortHash(`${n('usedMin')}:${n('extraMin')}`)}`,
      reason: `this run has used ${n('usedMin')} min of active time (the limit is ${n('limitMin')} min) and is still making progress — allow ${n('extraMin')} more minutes? Deny to stop it here (the task becomes stalled; the work done so far stays)`,
    };
  }
  if (name === PROPOSE_TASK_TOOL.toLowerCase()) {
    const agent = typeof toolInput.agentName === 'string' ? toolInput.agentName : '?';
    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
    return {
      dangerous: true,
      summary: `propose_task → ${agent} #${shortHash(`${agent}\n${prompt}`)}`,
      reason: `admin agent proposing to START a task for the agent "${agent}" (it will run immediately and use that agent's provider): ${prompt.replace(/\s+/g, ' ').slice(0, 160)}`,
    };
  }
  if (name === PROPOSE_BATCH_TOOL.toLowerCase()) {
    const items = Array.isArray(toolInput.items) ? (toolInput.items as { kind?: unknown }[]) : [];
    const counts = new Map<string, number>();
    for (const it of items) counts.set(String(it.kind), (counts.get(String(it.kind)) ?? 0) + 1);
    const kinds = [...counts].map(([k, n]) => `${n}× ${k}`).join(', ');
    return {
      dangerous: true,
      summary: `propose_batch ${items.length} change(s): ${kinds} #${shortHash(JSON.stringify(items))}`,
      reason: `admin agent proposing ${items.length} related changes in one go (${kinds})${typeof toolInput.reason === 'string' && toolInput.reason ? ` — ${toolInput.reason.slice(0, 160)}` : ''}`,
    };
  }
  if (name === PROPOSE_UNDO_TOOL.toLowerCase()) {
    const id = typeof toolInput.changeId === 'string' ? toolInput.changeId : '?';
    return {
      dangerous: true,
      summary: `propose_undo ${id}`,
      reason: `admin agent proposing to REVERT its earlier change ${id}${typeof toolInput.reason === 'string' && toolInput.reason ? ` — ${toolInput.reason.slice(0, 160)}` : ''}`,
    };
  }
  if (name === REQUEST_SECRET_TOOL.toLowerCase()) {
    const target = typeof toolInput.target === 'string' ? toolInput.target : '?';
    const nm = typeof toolInput.name === 'string' && toolInput.name ? ` "${toolInput.name}"` : '';
    return {
      dangerous: true,
      summary: `request_secret ${target}${nm}`,
      reason: `admin agent asks you to enter a secret (${target}${nm}) — type it only in the secure field; it goes straight to the server and never through the chat or the model`,
    };
  }
  if (name === PROPOSE_CLEANUP_TOOL.toLowerCase()) {
    const targets = [toolInput.runs !== false ? 'run folders' : '', toolInput.worktrees ? 'worktrees' : '', toolInput.deleteBranches ? 'agent branches (unpushed commits are LOST)' : ''].filter(Boolean);
    return {
      dangerous: true,
      summary: `propose_cleanup ${targets.join('+') || 'nothing'} older than ${toolInput.olderThanDays ?? 'default'} day(s) #${shortHash(JSON.stringify([toolInput.runs, toolInput.worktrees, toolInput.deleteBranches, toolInput.olderThanDays]))}`,
      reason: `admin agent proposing to delete: ${targets.join(', ') || 'nothing'}${typeof toolInput.reason === 'string' && toolInput.reason ? ` — ${toolInput.reason.slice(0, 200)}` : ''}`,
    };
  }
  if (name === PROPOSE_PACK_INSTALL_TOOL.toLowerCase()) {
    const pack = typeof toolInput.name === 'string' ? toolInput.name : '?';
    return {
      dangerous: true,
      summary: `propose_pack_install ${pack} #${shortHash(JSON.stringify([toolInput.name, toolInput.timezone]))}`,
      reason: `admin agent proposing to install the content pack "${pack}": its agents, skills, starter library notes and schedules (schedules start SWITCHED OFF). Anything that already exists is left untouched.`,
    };
  }
  if (name === PROPOSE_RESOURCE_TOOL.toLowerCase()) {
    const s = (k: string) => (typeof toolInput[k] === 'string' ? (toolInput[k] as string) : '');
    const action = s('action') || '?';
    return {
      dangerous: true,
      summary: `propose_resource ${action} "${s('title') || s('id') || '?'}" #${shortHash(JSON.stringify([toolInput.action, toolInput.id, toolInput.title, toolInput.description, toolInput.tags, toolInput.agents, toolInput.text]))}`,
      reason:
        action === 'delete'
          ? `admin agent proposing to DELETE the resource ${s('id')} from the project library`
          : `admin agent proposing to ${action === 'create' ? 'add' : 'change'} the note "${s('title') || s('id')}" in the project resource library (every agent will read it as project knowledge): ${s('text').replace(/\s+/g, ' ').slice(0, 200)}`,
    };
  }
  if (name === PROPOSE_CHANNEL_TOOL.toLowerCase()) {
    const s = (k: string) => (typeof toolInput[k] === 'string' ? (toolInput[k] as string) : '');
    const action = s('action') || '?';
    const bits = [
      s('kind') && `kind ${s('kind')}`,
      typeof toolInput.enabled === 'boolean' && (toolInput.enabled ? 'switch ON' : 'switch OFF'),
      s('defaultAgent') && `default agent "${s('defaultAgent')}"`,
      s('allowChatId') && `ALLOW chat ${s('allowChatId')} to control the platform`,
      s('removeChatId') && `remove chat ${s('removeChatId')}`,
    ].filter(Boolean);
    return {
      dangerous: true,
      summary: `propose_channel ${action} "${s('name') || '?'}" #${shortHash(JSON.stringify([toolInput.action, toolInput.name, toolInput.kind, toolInput.enabled, toolInput.defaultAgent, toolInput.allowChatId, toolInput.removeChatId]))}`,
      reason:
        action === 'delete'
          ? `admin agent proposing to DELETE the chat channel "${s('name')}"`
          : `admin agent proposing to ${action === 'create' ? 'create' : 'change'} the chat channel "${s('name')}"${bits.length ? `: ${bits.join(', ')}` : ''}. A chat on its allow-list can create tasks and approve actions — no secret is part of this request`,
    };
  }
  if (name === PROPOSE_SCHEDULE_TOOL.toLowerCase()) {
    const s = (k: string) => (typeof toolInput[k] === 'string' ? (toolInput[k] as string) : '');
    const action = s('action') || '?';
    const text = s('text').replace(/\s+/g, ' ').slice(0, 140);
    return {
      dangerous: true,
      summary: `propose_schedule ${action} "${s('name') || '?'}" #${shortHash(JSON.stringify([toolInput.action, toolInput.name, toolInput.cron, toolInput.timezone, toolInput.kind, toolInput.text, toolInput.agentName, toolInput.taskMode, toolInput.channel, toolInput.chatId, toolInput.quietStart, toolInput.quietEnd, toolInput.enabled]))}`,
      reason:
        action === 'delete'
          ? `admin agent proposing to DELETE the schedule "${s('name')}"`
          : `admin agent proposing to ${action === 'create' ? 'create' : 'change'} the schedule "${s('name')}": ${s('cron') || '(same time)'} ${s('timezone')} — ${s('kind') || '(same kind)'}${text ? `: ${text}` : ''}${s('kind') === 'task' ? ` — it runs a task with agent "${s('agentName')}" each time (${s('taskMode') === 'new' ? 'a new task per run' : 'the same task, continued'}) and uses model budget` : ''}`,
    };
  }
  if (name === PROPOSE_UPDATE_TOOL.toLowerCase()) {
    const v = typeof toolInput.version === 'string' && toolInput.version.trim() ? toolInput.version.trim() : 'the latest release';
    return {
      dangerous: true,
      summary: `propose_update ${v}${toolInput.force ? ' force' : ''} #${shortHash(JSON.stringify([toolInput.version, toolInput.force]))}`,
      reason: `admin agent proposing to UPDATE this server to ${v}. The server restarts for a minute or two (the dashboard and chats are unreachable meanwhile)${toolInput.force ? ' and running tasks are interrupted' : ''}; the previous version is kept for a rollback`,
    };
  }
  if (name === PROPOSE_ALLOWED_DOMAINS_TOOL.toLowerCase()) {
    const action = typeof toolInput.action === 'string' ? toolInput.action : '?';
    const domains = Array.isArray(toolInput.domains) ? toolInput.domains.map(String).join(', ') : '';
    return {
      dangerous: true,
      summary: `propose_allowed_domains ${action} #${shortHash(JSON.stringify([toolInput.action, toolInput.domains]))}`,
      reason: `admin agent proposing to ${action === 'clear' ? 'CLEAR the list of allowed domains (any name is accepted again)' : `${action} allowed domains: ${domains || '(none)'}`}. Once a list exists, other public domain names stop working (localhost, IP addresses and the local network always work)`,
    };
  }
  if (name === PROPOSE_CLOUDFLARE_ACCESS_TOOL.toLowerCase()) {
    const t = (k: string) => (typeof toolInput[k] === 'string' ? (toolInput[k] as string) : '?');
    return {
      dangerous: true,
      summary: `propose_cloudflare_access ${toolInput.enabled ? 'on' : 'off'} ${t('teamDomain')} #${shortHash(JSON.stringify([toolInput.enabled, toolInput.teamDomain, toolInput.aud]))}`,
      reason: `admin agent proposing to ${toolInput.enabled ? 'REQUIRE' : 'stop requiring'} the Cloudflare Access sign-in (team ${t('teamDomain')}) on public domain names${toolInput.enabled ? ' — a request without Cloudflare\'s signed token gets 403; localhost, IPs and the local network are unaffected' : ''}`,
    };
  }
  if (name === PROPOSE_PROVIDER_TOOL.toLowerCase()) {
    const t = (k: string) => (typeof toolInput[k] === 'string' ? (toolInput[k] as string) : '?');
    return {
      dangerous: true,
      summary: `propose_provider ${t('name')} #${shortHash(JSON.stringify([toolInput.name, toolInput.kind, toolInput.model, toolInput.baseUrl, toolInput.authMode, toolInput.makeDefault]))}`,
      reason: `admin agent proposing to create/update the provider "${t('name')}" (kind ${t('kind')}, model ${t('model')}, auth ${t('authMode')}${toolInput.makeDefault ? ', set as the DEFAULT provider' : ''}) — no secret is part of this request`,
    };
  }
  if (name === PROPOSE_AGENT_DELETE_TOOL.toLowerCase()) {
    const target = typeof toolInput.name === 'string' ? toolInput.name : '?';
    return {
      dangerous: true,
      summary: `propose_agent_delete ${target}`,
      reason: `admin agent proposing to delete the agent "${target}"${typeof toolInput.reason === 'string' && toolInput.reason ? ` — ${toolInput.reason.slice(0, 200)}` : ''}`,
    };
  }

  if (name === PROPOSE_AGENT_TOOL.toLowerCase() || name === PROPOSE_SKILL_TOOL.toLowerCase()) {
    const isAgent = name === PROPOSE_AGENT_TOOL.toLowerCase();
    const target = typeof toolInput.name === 'string' ? toolInput.name : '?';
    const content = typeof toolInput.content === 'string' ? toolInput.content : '';
    return {
      dangerous: true,
      // Hash in the summary so successive revisions of the same agent aren't
      // collapsed by the repeat-limit guard / "don't ask again" signature.
      summary: `${isAgent ? 'propose_agent' : 'propose_skill'} ${target} #${shortHash(content)}`,
      reason: isAgent
        ? `admin agent proposing to create/change an agent definition (agent/agents/). Grants: ${agentPowers(content)}`
        : 'admin agent proposing to create/change a custom skill (agent/skills/core/custom/)',
    };
  }

  // Our own in-process control-plane tools (report_task_status, heartbeat) touch
  // no external system and must never block on approval — otherwise the agent
  // can't report it's done. The server name is reserved (mcp registry rejects
  // it), so this prefix can't be spoofed by a user-registered server.
  if (name.startsWith(INTERNAL_TOOL_PREFIX)) {
    return { dangerous: false, summary: toolName, reason: '' };
  }

  // MCP tools reach external servers (browser, GitHub, DB, …) — default-deny,
  // EXCEPT a curated allowlist of read-only/navigation tools that carry no
  // mutation or data-exfiltration risk, so agents can navigate code and preview
  // UIs without an approval prompt on every call.
  if (name.startsWith('mcp__')) {
    if (isReadOnlyMcpTool(name, toolInput, opts.readOnlyMcp, opts.browserPage)) {
      return { dangerous: false, summary: toolName, reason: '' };
    }
    // merging a pull request (GitHub MCP `merge_pull_request`, …) is asked about even without approvals
    if (/(^|_)merge(_|$)/i.test(name.split('__').slice(2).join('__'))) return { dangerous: true, summary: toolName, reason: 'MCP tool call (external server): a merge', guard: 'merge' };
    // a write that names main / master as its branch (push_files, create_or_update_file, delete_file, create_branch from … into main)
    const target = ['branch', 'base', 'base_branch', 'target_branch', 'ref', 'head'].map((k) => toolInput[k]).find((v) => typeof v === 'string' && isMainRef(v));
    if (target) return { dangerous: true, summary: toolName, reason: `MCP tool call (external server) on the ${String(target).replace(/^refs\/heads\//, '')} branch`, guard: 'main-branch' };
    return { dangerous: true, summary: toolName, reason: 'MCP tool call (external server)' };
  }

  if (SHELL_TOOLS.has(name)) {
    const command = extractCommand(toolInput);
    const summary = command ? `$ ${command}` : `${toolName} (no command)`;
    // the path judgements below read `$LDS_ATTACHMENTS_DIR` / `$TMPDIR` as the folders they are; the text rules further down see the command as typed
    const analysed = expandKnownVars(command, opts.knownVars);
    const safeRm = isSafeRmInRoots(analysed, opts);
    // a command that writes, moves or deletes a credentials / protected file — wherever it is named from (a relative `.github/…`, `cd x && …`, `sh -c '…'`)
    const touched = shellProtectedTarget(analysed, opts);
    if (touched) {
      return { dangerous: true, summary, reason: touched.secret ? 'write to a credentials file (sign-in password / tokens)' : 'write to a protected file (SOUL.md/.github/.git/agent definitions)', hard: true };
    }
    const guarded = shellGuard(analysed, opts);
    for (const { re, reason, hard } of DANGEROUS_SHELL_PATTERNS) {
      if (safeRm && RM_REASONS.has(reason)) continue;
      if (re.test(command)) {
        if (hard) return { dangerous: true, summary, reason, hard: true };
        return { dangerous: true, summary, reason: guarded ? `${guarded.reason}: ${reason}` : reason, ...(guarded ? { guard: guarded.guard } : {}) };
      }
    }
    // not in the list of dangerous commands, but a merge / a main-branch action / a write beyond the working directory is still asked about
    if (guarded) return { dangerous: true, summary, reason: guarded.reason, guard: guarded.guard };
    return { dangerous: false, summary, reason: '' };
  }

  // Codex edits files through `apply_patch`; its input carries the whole patch text
  // (`*** Add/Update/Delete File: <path>`, `*** Move to: <path>`). Apply the same
  // protected-path / outside-worktree rules as the Write/Edit tools to every file it touches.
  if (name === 'apply_patch') {
    const patch = typeof toolInput.command === 'string' ? toolInput.command : typeof toolInput.input === 'string' ? toolInput.input : '';
    const paths = Array.from(patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm), (m) => m[1]!.trim());
    const summary = `apply_patch ${paths.join(', ') || '(no paths)'}`;
    for (const filePath of paths) {
      // judged by where it really is: a relative `.github/workflows/ci.yml` is the project's own
      const where = absolutePath(filePath, opts);
      if (isSecretPath(where)) {
        return { dangerous: true, summary, reason: 'write to a credentials file (sign-in password / tokens)', hard: true };
      }
      if (isProtectedPath(where)) {
        return { dangerous: true, summary, reason: 'write to a protected file (SOUL.md/.github/.git)', hard: true };
      }
      if (opts.workspaceRoot) {
        const absolute = filePath.startsWith('/') ? filePath : `${opts.workspaceRoot.replace(/\/$/, '')}/${filePath}`;
        if (!insideWriteRoots(absolute, opts)) {
          return { dangerous: true, summary, reason: `write outside the task worktree (${opts.workspaceRoot})`, guard: 'outside' };
        }
      }
    }
    return { dangerous: false, summary, reason: '' };
  }

  if (WRITE_TOOLS.has(name)) {
    const filePath = extractPath(toolInput);
    const summary = `${toolName} ${filePath}`;
    // Overwriting a credentials file (e.g. the sign-in password) is gated wherever the worktree boundary sits.
    if (filePath && isSecretPath(absolutePath(filePath, opts))) {
      return { dangerous: true, summary, reason: 'write to a credentials file (sign-in password / tokens)', hard: true };
    }
    // Protected files (charter / CI / git internals) must not be written silently (a relative path is read against the working directory).
    if (filePath && isProtectedPath(absolutePath(filePath, opts))) {
      return { dangerous: true, summary, reason: 'write to a protected file (SOUL.md/.github/.git)', hard: true };
    }
    // Writes outside the confined worktree are dangerous.
    if (opts.workspaceRoot && filePath) {
      const absolute = filePath.startsWith('/')
        ? filePath
        : `${opts.workspaceRoot.replace(/\/$/, '')}/${filePath}`;
      if (!insideWriteRoots(absolute, opts)) {
        return {
          dangerous: true,
          summary,
          reason: `write outside the task worktree (${opts.workspaceRoot})`,
          guard: 'outside',
        };
      }
    }
    return { dangerous: false, summary, reason: '' };
  }

  // Reading credentials is gated even though reading is otherwise free.
  if (name === 'read' || name === 'grep' || name === 'glob' || name === 'ls' || name === 'notebookread') {
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    // Grep filters by `glob`, Glob lists by `pattern` — both can name a credentials file without `path` doing so.
    const targets = [extractPath(toolInput), str(toolInput.glob), name === 'glob' ? str(toolInput.pattern) : ''].filter(Boolean);
    const target = targets.find((t) => isSecretPath(t));
    if (target) {
      return {
        dangerous: true,
        summary: `${toolName} ${target}`,
        reason: 'read of a credentials file (tokens/env/secrets could leak into the model context)',
        hard: true,
      };
    }
  }

  // Everything else (Read, Grep, Glob, LS, WebFetch, etc.) is auto-allowed.
  return { dangerous: false, summary: toolName, reason: '' };
}
