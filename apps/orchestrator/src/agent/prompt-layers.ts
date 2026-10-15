/**
 * How a run's prompt is split between the system block and the user message (E-04).
 *
 * Anthropic's prompt cache matches content blocks from the start; the system
 * block comes before every message, and our whole append is ONE block. So a
 * single changed byte in the append invalidates the cache for the entire
 * conversation on every follow-up / verify-fix / reporting-resume (written at
 * 125 % instead of read at 10 %). Hence:
 *
 *  - `systemAppend` holds only what is the same on every run of a session:
 *    orientation (paths, branch), SOUL + instructions + skills, the roster.
 *  - `runContext` holds what changes between runs — the project map (any file
 *    the agent created changes it) and the workspace memory digest — and goes
 *    into the user message of THIS run, first run and follow-up alike. A
 *    resumed session replays its earlier messages (with their own, older
 *    copies) and gets the current state in the new message; the system block
 *    stays byte-identical, so the replayed prefix is served from cache.
 */
export interface PromptLayerInput {
  /** Where the agent is (cwd, repo root, branch) + the workspace folders — static for a task. */
  orientation: string;
  /** SOUL + agent instructions + skills + resource/KB indexes (buildInstructions). */
  instructions: string;
  /** "Your colleagues" — how to reach the other agents ('' for chat agents). */
  roster: string;
  /** `git ls-files` map of the project ('' for chat agents / none). */
  projectMap: string;
  /** Workspace memory digest ('' when empty or not a working agent). */
  memory: string;
}

export interface PromptLayers {
  /** The system-prompt append — must not depend on anything that changes between runs. */
  systemAppend: string;
  /** Run-specific context, prepended to the agent's message ('' when there is none). */
  runContext: string;
}

/** The project map as a prompt block ('' for an empty map). */
export function projectMapBlock(projectMap: string): string {
  if (!projectMap.trim()) return '';
  return ['## Project map', "The project's files (git-tracked) at the start of this run — use this instead of scanning to find things:", '```', projectMap.trim(), '```'].join('\n');
}

export function assemblePromptLayers(input: PromptLayerInput): PromptLayers {
  const systemAppend = `${input.orientation}\n\n${input.instructions}${input.roster}`;
  const runContext = [projectMapBlock(input.projectMap), input.memory.trim()].filter(Boolean).join('\n\n');
  return { systemAppend, runContext };
}

/** The message the agent gets: the run context first (it is background), then the person's message. */
export function withRunContext(prompt: string, runContext: string): string {
  if (!runContext) return prompt;
  return `${runContext}\n\n---\n\n${prompt}`;
}
