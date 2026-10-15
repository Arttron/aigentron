import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HookWiring } from './types';

/**
 * The PreToolUse hook entry both runtimes get. Shared so the two settings files
 * (Claude's settings.json, Codex's hooks.json) can never drift apart again:
 *  - `timeout` is in SECONDS (SDK: "Timeout in seconds for this specific
 *    command"); the hook itself waits approvalTimeoutSeconds for a verdict,
 *    so this is a hard ceiling slightly above that.
 *  - `onFailure: 'block'`: when the script cannot start, times out or prints
 *    bad JSON, the tool call is BLOCKED. The SDK default is 'continue', i.e.
 *    fail-open — a missing hook script would silently skip approvals.
 */
export function hookEntry(hook: HookWiring): { type: 'command'; command: string; timeout: number; onFailure: 'block' } {
  return {
    type: 'command',
    command: `node ${hook.scriptPath}`,
    timeout: hook.approvalTimeoutSeconds + 15,
    onFailure: 'block',
  };
}

/** The `hooks` object for the Claude settings file (and Codex's hooks.json). */
export function hooksConfig(hook: HookWiring, matcher = '*'): Record<string, unknown> {
  return {
    PreToolUse: [{ matcher, hooks: [hookEntry(hook)] }],
  };
}

/**
 * Generate the per-agent settings.json that wires the PreToolUse approval hook.
 * Returns the absolute path to the written file (passed to query() as
 * options.settings). The hook command is `node <scriptPath>`; per-run context
 * (task id, approvals URL, timeout) travels via env vars set on the agent.
 *
 * We deliberately do NOT pre-allow tools here: the hook is the single gate. It
 * auto-allows safe tools and blocks dangerous ones for human approval — so we
 * never blanket-skip permissions.
 */
export async function writeAgentSettings(settingsDir: string, hook?: HookWiring): Promise<string> {
  await mkdir(settingsDir, { recursive: true });
  const settings: Record<string, unknown> = {};
  if (hook) settings.hooks = hooksConfig(hook);

  const path = join(settingsDir, 'settings.json');
  await writeFile(path, JSON.stringify(settings, null, 2));
  return path;
}
