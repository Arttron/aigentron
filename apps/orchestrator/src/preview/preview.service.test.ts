import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const BASE = 38200;
vi.stubEnv('PREVIEW_PORT_BASE', String(BASE));
vi.stubEnv('PREVIEW_POOL_SIZE', '2');
vi.stubEnv('PREVIEW_READY_TIMEOUT_MS', '20000');
vi.stubEnv('PREVIEW_PUBLIC_HOST', 'localhost');

const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'preview-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { dev: 'node server.js' } }));
  await writeFile(join(dir, 'server.js'), "require('http').createServer((q, r) => r.end('mine')).listen(Number(process.env.PORT), '0.0.0.0');");
  return dir;
}

const foreign: Server[] = [];
afterEach(async () => {
  await Promise.all(foreign.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

async function make() {
  const { PreviewService } = await import('./preview.service');
  return new PreviewService({ addonsDir: '/nonexistent' } as never);
}

describe('PreviewService: a preview is the dev server it started, never one that was already there', () => {
  it('skips a port that something else already answers on, and says so when none is left', async () => {
    const other = createServer((_q, r) => r.end('another project')).listen(BASE, '0.0.0.0');
    foreign.push(other);
    await new Promise((r) => other.once('listening', r));
    const svc = await make();
    const { url } = await svc.getOrStart('t1', await project());
    expect(url).toBe(`http://localhost:${BASE + 1}`); // not the busy one
    expect(await fetch(url).then((r) => r.text())).toBe('mine');
    // the second slot is ours now, the first still belongs to the stranger: nothing is left
    await expect(svc.getOrStart('t2', await project())).rejects.toThrow(/No free preview port: .*38200/);
    svc.stop('t1');
  }, 60000);

  it('stopping a preview ends the dev server too (the port is free again, nothing stays behind)', async () => {
    const svc = await make();
    const { url } = await svc.getOrStart('t3', await project());
    const port = Number(new URL(url).port);
    expect(await listening(port)).toBe(true);
    svc.stop('t3');
    for (let i = 0; i < 40 && (await listening(port)); i++) await new Promise((r) => setTimeout(r, 250));
    expect(await listening(port)).toBe(false);
  }, 60000);
});

describe('stop() says whether there was a preview', () => {
  it('true once for a running preview, false when none (stop_preview is safe to call twice)', async () => {
    const svc = await make();
    await svc.getOrStart('t9', await project());
    expect(svc.stop('t9')).toBe(true);
    expect(svc.stop('t9')).toBe(false);
  }, 60000);
});
