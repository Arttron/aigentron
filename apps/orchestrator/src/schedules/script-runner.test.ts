import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runScript } from './script-runner';

const cwd = mkdtempSync(join(tmpdir(), 'script-'));

describe('runScript', () => {
  it('runs a multi-line script in the folder and returns its output and exit code', async () => {
    const r = await runScript('echo one\npwd\nexit 3', { cwd });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('one');
    expect(r.output).toContain(cwd.replace(/^\/private/, ''));
    expect(r.timedOut).toBe(false);
  });
  it('merges stderr, and a failing command is a non-zero exit', async () => {
    const r = await runScript('echo out; echo err 1>&2; false', { cwd });
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
    expect(r.exitCode).toBe(1);
  });
  it('gives the script only a minimal environment: no secrets of the server', async () => {
    const r = await runScript('echo "[$MY_SECRET_KEY][$LDS_SCHEDULE]"', { cwd, env: { PATH: process.env.PATH, MY_SECRET_KEY: 'top-secret' }, extraEnv: { LDS_SCHEDULE: 'nightly' } });
    expect(r.output).toContain('[][nightly]');
  });
  it('kills a script (and its children) at the time limit', async () => {
    const r = await runScript('sleep 30 & sleep 30', { cwd, timeoutSec: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.ms).toBeLessThan(6000);
  });
  it('keeps only the tail of a long output and says so', async () => {
    const r = await runScript('i=0; while [ $i -lt 3000 ]; do echo line-$i; i=$((i+1)); done', { cwd, maxOutput: 500 });
    expect(r.output.length).toBeLessThanOrEqual(500);
    expect(r.output).toContain('line-2999');
    expect(r.truncated).toBe(true);
  });
  it('a missing folder is a result, not an exception', async () => {
    const r = await runScript('echo hi', { cwd: join(cwd, 'nope') });
    expect(r.exitCode).toBeNull();
    expect(r.output).toMatch(/could not start/);
  });
});
