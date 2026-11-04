import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execCommand } from './command-exec';

const base = { cwd: mkdtempSync(join(tmpdir(), 'cmd-exec-')), env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeoutSec: 20 };

describe('execCommand', () => {
  it('returns the exit code and what the command printed (stdout and stderr)', async () => {
    const r = await execCommand({ ...base, command: 'echo out; echo err 1>&2; exit 3' });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
    expect(r.timedOut).toBe(false);
  });

  it('runs in the given directory with exactly the given environment', async () => {
    const r = await execCommand({ ...base, env: { ...base.env, ONLY_THIS: 'yes' }, command: 'pwd; echo "$ONLY_THIS"; echo "[${HOME:-nohome}]"' });
    expect(r.output).toContain('yes');
    expect(r.output).toContain('[nohome]'); // HOME was not given
  });

  it('keeps the end of a long output', async () => {
    const r = await execCommand({ ...base, maxOutput: 100, command: 'i=0; while [ $i -lt 500 ]; do echo line-$i; i=$((i+1)); done' });
    expect(r.truncated).toBe(true);
    expect(r.output).toContain('line-499');
    expect(r.output).not.toContain('line-0\n');
    expect(r.output.length).toBeLessThanOrEqual(200);
  });

  it('kills a command that runs too long, with its children', async () => {
    const t = Date.now();
    const r = await execCommand({ ...base, timeoutSec: 1, command: 'sleep 30 & sleep 30' });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  it('stops on the cancel signal', async () => {
    const ctrl = new AbortController();
    const p = execCommand({ ...base, signal: ctrl.signal, command: 'sleep 30' });
    setTimeout(() => ctrl.abort(), 100);
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it('a command that cannot start is a result, not a throw', async () => {
    const r = await execCommand({ ...base, cwd: '/definitely/not/here', command: 'echo hi' });
    expect(r.exitCode).toBeNull();
    expect(r.output).toContain('could not start');
  });

  it('does not hang on a daemon that escaped the process group and keeps the output open', async () => {
    const t = Date.now();
    const r = await execCommand({ ...base, timeoutSec: 20, command: 'echo done; (setsid sleep 5 2>/dev/null || sleep 5) & exit 0' });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('done');
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
