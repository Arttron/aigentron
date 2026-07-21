import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HookWiring } from './types';

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

  if (hook) {
    const timeoutMs = (hook.approvalTimeoutSeconds + 15) * 1000;
    settings.hooks = {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `node ${hook.scriptPath}`,
              timeout: timeoutMs,
            },
          ],
        },
      ],
    };
  }

  const path = join(settingsDir, 'settings.json');
  await writeFile(path, JSON.stringify(settings, null, 2));
  return path;
}
