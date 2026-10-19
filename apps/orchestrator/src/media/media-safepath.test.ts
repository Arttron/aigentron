import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import { MediaService } from './media.service';

let base: string;
let svc: MediaService;
const make = (cfg: Partial<AppConfigService> = {}) => new MediaService({ attachmentsDir: join(base, 'attachments'), workspaceDir: join(base, 'ws'), agentDir: join(base, 'agent'), ...cfg } as AppConfigService, {} as never, {} as never);
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'safe-'))); // macOS: /var → /private/var
  for (const d of ['attachments/tA', 'attachments/tB', 'ws', 'agent/resources']) await mkdir(join(base, d), { recursive: true });
  await writeFile(join(base, 'attachments/tA/a.txt'), 'a');
  await writeFile(join(base, 'attachments/tB/b.txt'), 'b');
  svc = make();
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe('safePath with a task id', () => {
  it('allows this task\'s attachments only, not another task\'s', async () => {
    await expect(svc.safePath(join(base, 'attachments/tA/a.txt'), undefined, 'tA')).resolves.toContain('a.txt');
    await expect(svc.safePath(join(base, 'attachments/tB/b.txt'), undefined, 'tA')).rejects.toThrow(/not available/);
  });
  it('allows the project folder the caller names (the task\'s own), as an extra root', async () => {
    await writeFile(join(base, 'ws/r.txt'), 'r');
    await expect(svc.safePath(join(base, 'ws/r.txt'), [join(base, 'ws')], 'tA')).resolves.toContain('r.txt');
  });
  it('a task of one project cannot reach another project\'s folder, nor the shared workspace of the default project', async () => {
    for (const d of ['projects/alpha/deliverables', 'projects/beta/deliverables']) await mkdir(join(base, d), { recursive: true });
    await writeFile(join(base, 'projects/alpha/deliverables/a.png'), 'a');
    await writeFile(join(base, 'projects/beta/deliverables/b.png'), 'b');
    await writeFile(join(base, 'ws/w.png'), 'w');
    const mine = [join(base, 'projects/alpha')];
    await expect(svc.safePath(join(base, 'projects/alpha/deliverables/a.png'), mine, 'tA')).resolves.toContain('a.png');
    await expect(svc.safePath(join(base, 'projects/beta/deliverables/b.png'), mine, 'tA')).rejects.toThrow(/not available/);
    await expect(svc.safePath(join(base, 'ws/w.png'), mine, 'tA')).rejects.toThrow(/not available/);
    // the HTTP endpoints (no task id) keep the shared workspace, as before
    await expect(svc.safePath(join(base, 'ws/w.png'))).resolves.toContain('w.png');
  });
  it('rejects a task id that is a path', async () => {
    await expect(svc.safePath(join(base, 'attachments/tB/b.txt'), undefined, '../tB')).rejects.toThrow();
  });
});

describe('safePath: symlinks, empty roots, unicode, ..', () => {
  it('a symlink inside a root that points out of every root is refused', async () => {
    await writeFile(join(base, 'secret.txt'), 's');
    await symlink(join(base, 'secret.txt'), join(base, 'ws', 'sneaky.txt'));
    await expect(svc.safePath(join(base, 'ws', 'sneaky.txt'))).rejects.toThrow(/not found/);
  });
  it('a symlink that stays inside a root resolves to the real file', async () => {
    await writeFile(join(base, 'ws', 'real.jpg'), 'x');
    await symlink(join(base, 'ws', 'real.jpg'), join(base, 'ws', 'alias.jpg'));
    expect(await svc.safePath(join(base, 'ws', 'alias.jpg'))).toBe(join(base, 'ws', 'real.jpg'));
  });
  it('a root that is itself a symlink still works (the real path is compared)', async () => {
    await mkdir(join(base, 'realws'));
    await writeFile(join(base, 'realws', 'p.png'), 'x');
    await symlink(join(base, 'realws'), join(base, 'wslink'));
    const s = make({ workspaceDir: join(base, 'wslink') });
    expect(await s.safePath(join(base, 'wslink', 'p.png'))).toBe(join(base, 'realws', 'p.png'));
  });
  it('an empty root never allows everything', async () => {
    const s = make({ workspaceDir: '' });
    await writeFile(join(base, 'secret.txt'), 's');
    await expect(s.safePath(join(base, 'secret.txt'))).rejects.toThrow(/not available/);
    await expect(s.safePath('/etc/passwd')).rejects.toThrow(/not available/);
  });
  it('rejects `..`, relative paths and a sibling folder with the root as prefix', async () => {
    await expect(svc.safePath(`${base}/ws/../attachments/tA/a.txt`)).rejects.toThrow(/not available/);
    await expect(svc.safePath('ws/a.txt')).rejects.toThrow(/not available/);
    await mkdir(join(base, 'wsX'));
    await writeFile(join(base, 'wsX', 'z.txt'), 'z');
    await expect(svc.safePath(join(base, 'wsX', 'z.txt'))).rejects.toThrow(/not available/);
  });
  it('keeps unicode file names', async () => {
    await writeFile(join(base, 'ws', 'кухня 2.jpg'), 'x');
    expect(await svc.safePath(join(base, 'ws', 'кухня 2.jpg'))).toBe(join(base, 'ws', 'кухня 2.jpg'));
  });
  it('a missing file is "not found", a secret file too', async () => {
    await expect(svc.safePath(join(base, 'ws', 'none.jpg'))).rejects.toThrow(/not found/);
    await mkdir(join(base, 'ws', 'codex-home'), { recursive: true });
    await writeFile(join(base, 'ws', 'codex-home', 'auth.json'), '{}');
    await expect(svc.safePath(join(base, 'ws', 'codex-home', 'auth.json'))).rejects.toThrow(/not found/);
  });
});
