import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain ESM script of the installer, no typings
import { STEPS, page, portsOf, readProgress } from '../../../../infra/maintenance-holder.mjs';

const HOLDER = resolve(__dirname, '../../../../infra/maintenance-holder.mjs');
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL');
});

const now = Date.now();
const line = (key: string) => `${now}${'0'.repeat(0)} ${key}`;

describe('the progress file', () => {
  it('nothing announced yet: every step still to do', () => {
    const p = readProgress('');
    expect(p.steps.every((s: { state: string }) => s.state === 'todo')).toBe(true);
    expect(p.rollback).toBe(false);
  });
  it('steps before the current one are done, the current one is doing', () => {
    const p = readProgress([line('stopping'), line('snapshot'), line('migrate')].join('\n'));
    expect(p.steps.map((s: { state: string }) => s.state)).toEqual(['done', 'done', 'doing', 'todo', 'todo']);
  });
  it('a rollback ends the list and is flagged', () => {
    const p = readProgress([line('stopping'), line('snapshot'), line('rollback')].join('\n'));
    expect(p.rollback).toBe(true);
    expect(p.steps.map((s: { state: string }) => s.state)).toEqual(['done', 'done', 'todo', 'todo', 'todo']);
  });
  it('junk lines are ignored', () => {
    expect(readProgress('hello\n\n12 x\nnot a line').steps.every((s: { state: string }) => s.state === 'todo')).toBe(true);
    expect(STEPS.length).toBe(5);
  });
});

describe('the page', () => {
  it('names the version, escapes it, and polls the health endpoint', () => {
    const html = page({ version: '0.1.96', from: '0.1.95' });
    expect(html).toContain('Updating Aigentron to 0.1.96');
    expect(html).toContain('/api/health');
    expect(page({ version: '<script>x</script>', from: '' })).not.toContain('<script>x</script>');
  });
});

describe('the ports it holds', () => {
  it('the API port, plus the HTTP / HTTPS ports of the saved web settings (HTTPS only with its certificate)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'holder-'));
    expect(portsOf({ port: 3001, secrets: dir })).toMatchObject({ api: 3001, http: 0, https: 0, tls: null }); // no certificate: no HTTPS
    writeFileSync(join(dir, 'web-server.json'), JSON.stringify({ httpPort: 80, httpsPort: 8443 }));
    mkdirSync(join(dir, 'tls'));
    writeFileSync(join(dir, 'tls', 'fullchain.pem'), 'x');
    writeFileSync(join(dir, 'tls', 'privkey.pem'), 'y');
    expect(portsOf({ port: 3001, secrets: dir })).toMatchObject({ api: 3001, http: 80, https: 8443 });
  });
});

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

async function start(extra: string[] = []) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'holder-'));
  const progress = join(dir, 'progress');
  writeFileSync(progress, `${line('stopping')}\n${line('snapshot')}\n`);
  const p = spawn('node', [HOLDER, '--version', '0.1.96', '--from', '0.1.95', '--port', String(port), '--host', '127.0.0.1', '--progress', progress, ...extra], { stdio: 'ignore' });
  procs.push(p);
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { port, p, progress };
}

describe('the running holder', () => {
  it('health says updating (never ok), the page is a 503 with Retry-After, the API answers 503 with the marker header', async () => {
    const { port } = await start();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: 'updating', version: '0.1.96' });
    const home = await fetch(`http://127.0.0.1:${port}/`);
    expect(home.status).toBe(503);
    expect(home.headers.get('retry-after')).toBeTruthy();
    expect(home.headers.get('x-aigentron-updating')).toBe('1');
    expect(await home.text()).toContain('Updating Aigentron');
    const api = await fetch(`http://127.0.0.1:${port}/api/tasks`);
    expect(api.status).toBe(503);
    expect(api.headers.get('x-aigentron-updating')).toBe('1');
    expect(await api.json()).toMatchObject({ updating: true });
    expect((await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4`)).status).toBe(503);
  }, 20000);
  it('/__update/status follows the progress file and shows nothing but the steps', async () => {
    const { port, progress } = await start();
    const s = (await (await fetch(`http://127.0.0.1:${port}/__update/status`)).json()) as { steps: { text: string; state: string }[]; version: string };
    expect(s.steps.map((x) => x.state)).toEqual(['done', 'doing', 'todo', 'todo', 'todo']);
    writeFileSync(progress, `${line('stopping')}\n${line('snapshot')}\n${line('migrate')}\n`);
    const t = (await (await fetch(`http://127.0.0.1:${port}/__update/status`)).json()) as { steps: { state: string }[] };
    expect(t.steps.map((x) => x.state)).toEqual(['done', 'done', 'doing', 'todo', 'todo']);
    expect(Object.keys(s).sort()).toEqual(['done', 'from', 'lastAt', 'rollback', 'steps', 'version']);
  }, 20000);
  it('on SIGTERM it lets go of the port (the real server can take it)', async () => {
    const { port, p } = await start();
    p.kill('SIGTERM');
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/health`);
      } catch {
        return; // refused: the port is free
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the holder still held the port');
  }, 20000);
});
