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
export const CHECK_SUBTASKS_TOOL = `${INTERNAL_TOOL_PREFIX}check_subtasks`;
/** Sentinel toolName for a "run out of steps — continue?" approval (not a real tool). */
export const CONTINUE_RUN_TOOL = '__continue_run__';
/** Schedule a delayed re-run of this task ("check back in N seconds"). */
export const SCHEDULE_CHECK_TOOL = `${INTERNAL_TOOL_PREFIX}schedule_check`;
/** Start (or reuse) an ephemeral dev server for this task's worktree, for preview. */
export const PREVIEW_TOOL = `${INTERNAL_TOOL_PREFIX}preview_worktree`;
/**
 * Propose a write to agent/skills/learned/<name>.md (roadmap Phase 6 — skill
 * lifecycle). Unlike every other internal tool, this ONE is deliberately NOT
 * exempt from the approval gate below — it mutates a file every future agent
 * run reads as context, so a human must sign off, same as any other dangerous
 * write. Kept as an internal MCP tool (not the generic Write tool) because the
 * target lives outside any task's worktree.
 */
export const PROPOSE_LEARNED_SKILL_TOOL = `${INTERNAL_TOOL_PREFIX}propose_learned_skill`;

export interface ClassifyOptions {
  /**
   * Absolute path of the worktree the agent is confined to. When provided,
   * file writes resolving outside it are flagged as dangerous.
   */
  workspaceRoot?: string;
}

export interface DangerVerdict {
  dangerous: boolean;
  /** Human-readable description of the action (shown in the approvals UI). */
  summary: string;
  /** Why it was flagged. Empty when not dangerous. */
  reason: string;
}

/** Shell command patterns that are destructive, irreversible, or outbound. */
const DANGEROUS_SHELL_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, reason: 'recursive force remove (rm -rf)' },
  { re: /\brm\s+-[a-z]*r[a-z]*\b/i, reason: 'recursive remove (rm -r)' },
  { re: /\bgit\s+push\b/i, reason: 'git push (publishes commits to a remote)' },
  { re: /--force\b|\s-f\b/i, reason: 'force flag' },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: 'git hard reset (discards work)' },
  { re: /\bgit\s+clean\b/i, reason: 'git clean (deletes untracked files)' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, reason: 'package publish' },
  { re: /\bdocker\s+push\b/i, reason: 'docker image push' },
  { re: /\b(terraform|tofu)\s+(destroy|apply)\b/i, reason: 'infrastructure mutation' },
  { re: /\bkubectl\s+(delete|apply|drain|cordon)\b/i, reason: 'kubernetes cluster mutation' },
  // Outbound network — broadened beyond `curl -X`.
  { re: /\bcurl\b[^\n]*\s(-d|--data\S*|--upload-file|-T|-F|--form|-X|--request)\b/i, reason: 'outbound curl request/upload' },
  { re: /\bwget\b[^\n]*--(post-data|post-file|method)\b/i, reason: 'outbound wget post' },
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

/** Hosts a browser may navigate to without approval (local dev only). Anything
 *  else is gated so navigation can't become an outbound-exfil channel that
 *  bypasses the shell's outbound-network gate. */
function isLocalNavUrl(url: string): boolean {
  if (!url) return true;
  if (!/^[a-z]+:\/\//i.test(url)) return true; // relative path → same origin
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal|dashboard|orchestrator|project-dev|playwright-mcp)(:\d+)?(\/|$)/i.test(
    url,
  );
}

/** True if an `mcp__<server>__<tool>` call is a safe read-only/navigation op. */
function isReadOnlyMcpTool(name: string, toolInput: Record<string, unknown>): boolean {
  const parts = name.split('__'); // ['mcp', '<server>', '<tool>...']
  if (parts.length < 3) return false;
  const server = parts[1];
  const tool = parts.slice(2).join('__');
  switch (server) {
    case 'code-intel':
      return CODE_INTEL_READONLY.has(tool);
    case 'github':
      // GitHub MCP read verbs, in both `verb_noun` (get_me, list_commits) and the
      // remote server's toolset `noun_verb` naming (actions_list, repos_get,
      // pull_requests_get, actions_download_*). Mutating verbs (create/update/
      // merge/push/delete/run/rerun/cancel/dispatch) stay gated. The server is
      // also configured read-only, so write tools aren't even exposed.
      return /(^|_)(get|list|search|read|download)(_|$)/i.test(tool);
    case 'playwright':
      if (tool === 'browser_navigate') {
        return isLocalNavUrl(typeof toolInput.url === 'string' ? toolInput.url : '');
      }
      return PLAYWRIGHT_READONLY.has(tool);
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
    lower.includes('/.github/') ||
    lower.includes('/.git/') ||
    lower.endsWith('/.lds') ||
    lower.includes('/.lds/')
  );
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

function isInside(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
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
    if (isReadOnlyMcpTool(name, toolInput)) {
      return { dangerous: false, summary: toolName, reason: '' };
    }
    return { dangerous: true, summary: toolName, reason: 'MCP tool call (external server)' };
  }

  if (SHELL_TOOLS.has(name)) {
    const command = extractCommand(toolInput);
    const summary = command ? `$ ${command}` : `${toolName} (no command)`;
    for (const { re, reason } of DANGEROUS_SHELL_PATTERNS) {
      if (re.test(command)) {
        return { dangerous: true, summary, reason };
      }
    }
    return { dangerous: false, summary, reason: '' };
  }

  if (WRITE_TOOLS.has(name)) {
    const filePath = extractPath(toolInput);
    const summary = `${toolName} ${filePath}`;
    // Protected files (charter / CI / git internals) must not be written silently.
    if (filePath && isProtectedPath(filePath)) {
      return { dangerous: true, summary, reason: 'write to a protected file (SOUL.md/.github/.git)' };
    }
    // Writes outside the confined worktree are dangerous.
    if (opts.workspaceRoot && filePath) {
      const absolute = filePath.startsWith('/')
        ? filePath
        : `${opts.workspaceRoot.replace(/\/$/, '')}/${filePath}`;
      if (!isInside(absolute, opts.workspaceRoot)) {
        return {
          dangerous: true,
          summary,
          reason: `write outside the task worktree (${opts.workspaceRoot})`,
        };
      }
    }
    return { dangerous: false, summary, reason: '' };
  }

  // Everything else (Read, Grep, Glob, LS, WebFetch, etc.) is auto-allowed.
  return { dangerous: false, summary: toolName, reason: '' };
}
