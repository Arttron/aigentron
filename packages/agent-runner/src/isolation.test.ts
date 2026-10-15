import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentCommand, assertIsolationReady, isolationEnv, resolveClaudeExecutable, runAsAgent, spawnAsAgent } from './isolation';
import type { AgentIsolation } from './types';

const iso: AgentIsolation = { uid: 1500, gid: 1500, wrapper: '/app/infra/agent-exec.sh', home: '/data/agent/runs/t1/home' };

describe('isolationEnv', () => {
  it('moves HOME/TMPDIR/XDG into the per-task home and hands the wrapper its target', () => {
    const env = isolationEnv(iso, '/opt/claude');
    expect(env).toMatchObject({
      HOME: '/data/agent/runs/t1/home',
      TMPDIR: '/data/agent/runs/t1/home/tmp',
      XDG_CACHE_HOME: '/data/agent/runs/t1/home/.cache',
      LDS_AGENT_EXEC: '/opt/claude',
      LDS_AGENT_UID: '1500',
      LDS_AGENT_GID: '1500',
    });
  });
});

describe('agentCommand', () => {
  it('is a no-op without isolation (today’s behaviour)', () => {
    const c = agentCommand('codex', ['exec', '-'], { PATH: '/bin', HOME: '/root' });
    expect(c).toEqual({ command: 'codex', args: ['exec', '-'], env: { PATH: '/bin', HOME: '/root' } });
  });
  it('routes through the wrapper and overrides HOME with isolation', () => {
    const c = agentCommand('codex', ['exec', '-'], { PATH: '/bin', HOME: '/root' }, iso);
    expect(c.command).toBe('/app/infra/agent-exec.sh');
    expect(c.args).toEqual(['exec', '-']);
    expect(c.env.HOME).toBe('/data/agent/runs/t1/home');
    expect(c.env.LDS_AGENT_EXEC).toBe('codex');
    expect(c.env.PATH).toBe('/bin');
  });
});

describe('assertIsolationReady (fail closed)', () => {
  it('rejects root / non-integer ids', async () => {
    await expect(assertIsolationReady({ ...iso, uid: 0 })).rejects.toThrow(/never root/);
    await expect(assertIsolationReady({ ...iso, gid: Number.NaN })).rejects.toThrow(/positive integers/);
  });
  it('rejects a missing wrapper', async () => {
    await expect(assertIsolationReady({ ...iso, wrapper: '/nonexistent/agent-exec.sh' })).rejects.toThrow(/missing or not executable/);
  });
  it('rejects a wrapper that does not switch to the agent uid (e.g. setpriv unavailable)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iso-'));
    const wrapper = join(dir, 'agent-exec.sh');
    // Mirrors the real wrapper's own fail-closed branch: no setpriv → a clear message and exit 126.
    await writeFile(wrapper, '#!/bin/sh\necho "agent-exec: setpriv (util-linux) is not installed" >&2\nexit 126\n');
    await chmod(wrapper, 0o755);
    await expect(assertIsolationReady({ ...iso, wrapper })).rejects.toThrow(/setpriv \(util-linux\) is not installed/);
  });
  it('rejects a wrapper that runs the command as the wrong user', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iso-'));
    const wrapper = join(dir, 'agent-exec.sh');
    await writeFile(wrapper, '#!/bin/sh\nexec "$LDS_AGENT_EXEC" "$@"\n'); // no privilege drop at all
    await chmod(wrapper, 0o755);
    await expect(assertIsolationReady({ ...iso, wrapper })).rejects.toThrow(/ran as uid \d+ instead of 1500/);
  });
});

describe('spawnAsAgent / runAsAgent', () => {
  it('spawns the plain command without isolation', async () => {
    const child = spawnAsAgent('sh', ['-c', 'echo plain'], { env: { PATH: process.env.PATH ?? '/bin:/usr/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    await new Promise((r) => child.on('close', r));
    expect(out.trim()).toBe('plain');
  });
  it('hands the wrapper the real command through the env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iso-'));
    const wrapper = join(dir, 'agent-exec.sh');
    await writeFile(wrapper, '#!/bin/sh\necho "exec=$LDS_AGENT_EXEC uid=$LDS_AGENT_UID home=$HOME args=$*"\n');
    await chmod(wrapper, 0o755);
    const r = await runAsAgent({ ...iso, wrapper }, 'sh', ['-c', 'true']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('exec=sh uid=1500 home=/data/agent/runs/t1/home args=-c true');
  });
});

describe('resolveClaudeExecutable', () => {
  it('finds the SDK’s native binary for this platform', () => {
    expect(resolveClaudeExecutable()).toMatch(new RegExp(`claude-agent-sdk-${process.platform}-${process.arch}(-musl)?/claude`));
  });
});
