import { CREATE_TASK_TOOL, INTERNAL_TOOL_PREFIX, PUSH_BRANCH_TOOL, type DangerVerdict } from '@lds/shared';

/**
 * `ask` (default): a risky action waits for a person. `off`: the agent's own risky actions (shell, writes outside its folders, MCP calls,
 * git push, starting a task) go ahead without a card. Even then, never waved through: credentials / protected files (the verdict is
 * `hard`) and everything an admin proposal changes on the platform (settings, providers, agents, updates … — a person confirms those).
 */
export type ApprovalMode = 'ask' | 'off';

export const parseApprovalMode = (raw: unknown): ApprovalMode => (raw === 'off' ? 'off' : 'ask');

/** The internal tools an agent may run without a card in `off` mode (they are the agent's own work, not a platform change). */
const AGENT_OWN_INTERNAL = new Set([PUSH_BRANCH_TOOL.toLowerCase(), CREATE_TASK_TOOL.toLowerCase()]);

export function approvalWaived(mode: ApprovalMode, toolName: string, verdict: Pick<DangerVerdict, 'dangerous' | 'hard'>): boolean {
  if (mode !== 'off' || !verdict.dangerous || verdict.hard) return false;
  const name = toolName.toLowerCase();
  if (name.startsWith(INTERNAL_TOOL_PREFIX)) return AGENT_OWN_INTERNAL.has(name);
  return true;
}

/** A stored level value: `ask` / `off`, anything else (null, junk) = "not set here, follow the level above". */
export const parseLevel = (raw: unknown): ApprovalMode | null => (raw === 'ask' || raw === 'off' ? raw : null);

export type ModeSource = 'task' | 'ancestor' | 'project' | 'global' | 'default';

export interface ModeLayers {
  /** the task itself */
  task?: unknown;
  /** its lead, then the lead's lead … nearest first */
  ancestors?: readonly unknown[];
  project?: unknown;
  /** the global setting (`ask` when never set) */
  global?: unknown;
}

/**
 * Levels, most specific first: the task → the leads above it (a subtask follows its lead) → the project → the global setting. The first level
 * that is set wins, in BOTH directions: a task can switch approvals off in a project that asks, or on in a project that does not.
 */
export function resolveApprovalMode(l: ModeLayers): { mode: ApprovalMode; source: ModeSource } {
  const own = parseLevel(l.task);
  if (own) return { mode: own, source: 'task' };
  for (const a of l.ancestors ?? []) {
    const m = parseLevel(a);
    if (m) return { mode: m, source: 'ancestor' };
  }
  const proj = parseLevel(l.project);
  if (proj) return { mode: proj, source: 'project' };
  const glob = parseLevel(l.global);
  return glob ? { mode: glob, source: 'global' } : { mode: 'ask', source: 'default' };
}
