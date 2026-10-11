import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    existsSync: (p: string) => (p === '/run/systemd/system' ? true : real.existsSync(p)),
    statfsSync: () => ({ bavail: 10_000_000, bsize: 4096 }),
  };
});

import { UpdateService } from './update.service';

function make(running = 0) {
  const data = mkdtempSync(join(tmpdir(), 'upd-'));
  const config = { secretsDir: join(data, 'secrets') };
  const prisma = { task: { count: vi.fn(async () => running) } };
  return { svc: new UpdateService(config as never, prisma as never), data };
}

const release = { tag_name: 'v0.1.48', body: 'New things', html_url: 'https://github.com/x/y/releases/v0.1.48', published_at: '2026-10-10T00:00:00Z' };

describe('UpdateService', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.APP_DIR = '/opt/aigentron/current';
    process.env.APP_VERSION = '0.1.47';
    process.env.UPDATE_DRY_RUN = '1';
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => release })));
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports a newer release and that this install can update itself', async () => {
    const { svc } = make();
    const s = await svc.status();
    expect(s).toMatchObject({ current: '0.1.47', latest: '0.1.48', newer: true, runningTasks: 0 });
    expect(s.environment).toMatchObject({ canApply: true, kind: 'bare-metal', installDir: '/opt/aigentron' });
  });

  it('applies the latest: writes a runner script for the target release (dry run: nothing is launched)', async () => {
    const { svc, data } = make();
    const r = await svc.apply({});
    expect(r).toEqual({ started: true, version: '0.1.48' });
    const dir = join(data, 'update');
    const file = readdirSync(dir).find((f) => f.startsWith('run-'))!;
    const script = readFileSync(join(dir, file), 'utf8');
    expect(script).toContain("VERSION='0.1.48'");
    expect(script).toContain('INSTALL_MODE=bare');
  });

  it('refuses while tasks run unless forced; refuses the same or an older version; refuses when not root or not a bare-metal install', async () => {
    await expect(make(2).svc.apply({})).rejects.toThrow(/2 tasks are running/);
    await expect(make(2).svc.apply({ force: true })).resolves.toMatchObject({ started: true });
    await expect(make().svc.apply({ version: '0.1.47' })).rejects.toThrow(/not newer/);
    await expect(make().svc.apply({ version: '0.1.40' })).rejects.toThrow(/not newer/);
    await expect(make().svc.apply({ version: '0.1.48; reboot' })).rejects.toThrow(/Give a version/);
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    await expect(make().svc.apply({})).rejects.toThrow(/root/);
    delete process.env.APP_DIR;
    expect(make().svc.environment().canApply).toBe(false);
  });

  it('a development run (version "dev") is never "newer"', async () => {
    process.env.APP_VERSION = 'dev';
    expect((await make().svc.status()).newer).toBe(false);
  });

  it('survives GitHub being unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const s = await make().svc.status(true);
    expect(s).toMatchObject({ latest: null, newer: false, checkError: 'offline' });
  });
});
