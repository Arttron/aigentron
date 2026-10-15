import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHooks } from './codex';
import { hookEntry, writeAgentSettings } from './settings';
import type { HookWiring } from './types';

const hook: HookWiring = {
  scriptPath: '/opt/lds/hook.js',
  approvalsUrl: 'http://127.0.0.1:3001',
  approvalTimeoutSeconds: 300,
  secret: 's',
  taskId: 't1',
  agentSessionId: 'a1',
  sharedDistPath: '/opt/lds/shared',
};

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe('PreToolUse approval hook wiring', () => {
  it('is fail-closed and bounded in seconds (not milliseconds)', () => {
    const entry = hookEntry(hook);
    expect(entry.onFailure).toBe('block'); // a hook that cannot start / times out must BLOCK the tool, not let it through
    expect(entry.timeout).toBe(315); // approvalTimeoutSeconds + 15 — the SDK reads seconds
    expect(entry.timeout).toBeLessThan(3600 * 24);
    expect(entry.command).toBe('node /opt/lds/hook.js');
  });

  it('writeAgentSettings writes exactly that entry under PreToolUse for every tool', async () => {
    dir = await mkdtemp(join(tmpdir(), 'lds-settings-'));
    const path = await writeAgentSettings(join(dir, 'run'), hook);
    const settings = JSON.parse(await readFile(path, 'utf8')) as { hooks: { PreToolUse: { matcher: string; hooks: unknown[] }[] } };
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0]!.matcher).toBe('*');
    expect(settings.hooks.PreToolUse[0]!.hooks).toEqual([hookEntry(hook)]);
    // no pre-allowed tools or permission bypass: the hook is the single gate
    expect(Object.keys(settings)).toEqual(['hooks']);
  });

  it('writes an empty settings file without a hook', async () => {
    dir = await mkdtemp(join(tmpdir(), 'lds-settings-'));
    const path = await writeAgentSettings(dir);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({});
  });

  it("Codex's hooks.json carries the same gate", () => {
    const rendered = JSON.parse(renderHooks({ hook })) as { hooks: { PreToolUse: { hooks: unknown[] }[] } };
    expect(rendered.hooks.PreToolUse[0]!.hooks).toEqual([hookEntry(hook)]);
    expect(JSON.parse(renderHooks({}))).toEqual({ hooks: {} });
  });
});
