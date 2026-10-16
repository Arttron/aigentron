import { mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MaintenanceService } from './maintenance.service';

const DAY = 86_400_000;
const age = (path: string, days: number) => {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(path, t, t);
};

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  delete process.env.ATTACHMENTS_RETENTION_DAYS;
});

function setup(tasks: { id: string; status: string; updatedAt: Date }[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'mt-'));
  roots.push(root);
  const agentDir = join(root, 'agent');
  const attachmentsDir = join(agentDir, 'attachments');
  const cache = join(agentDir, 'cache', 'digests');
  // the cache folder (where digests live now) …
  mkdirSync(join(cache, 'aaaa'), { recursive: true });
  mkdirSync(join(cache, 'bbbb'), { recursive: true });
  writeFileSync(join(cache, 'aaaa', 'frame.jpg'), 'x'.repeat(1000));
  writeFileSync(join(cache, 'bbbb', 'frame.jpg'), 'x'.repeat(1000));
  // … and a digest an older version left next to a video (in the attachments) and one in the workspace
  mkdirSync(join(attachmentsDir, 't1', 'old.mp4.digest'), { recursive: true });
  writeFileSync(join(attachmentsDir, 't1', 'old.mp4.digest', 'frame.jpg'), 'x'.repeat(1000));
  writeFileSync(join(attachmentsDir, 't1', 'old.mp4'), 'VIDEO');
  mkdirSync(join(root, 'ws', 'work', 'clip.webm.digest'), { recursive: true });
  mkdirSync(join(agentDir, 'research-cache'), { recursive: true });
  writeFileSync(join(agentDir, 'research-cache', 'old.json'), '{}');
  writeFileSync(join(agentDir, 'research-cache', 'new.json'), '{}');
  age(join(cache, 'aaaa'), 60);
  age(join(cache, 'bbbb'), 1);
  age(join(attachmentsDir, 't1', 'old.mp4.digest'), 60);
  age(join(root, 'ws', 'work', 'clip.webm.digest'), 60);
  age(join(agentDir, 'research-cache', 'old.json'), 400);
  const prisma = { task: { findMany: async ({ where, select }: { where: { id: { in: string[] } }; select: Record<string, boolean> }) => tasks.filter((t) => where.id.in.includes(t.id)).map((t) => (select.status ? { id: t.id, status: t.status } : { id: t.id, updatedAt: t.updatedAt })) } };
  const svc = new MaintenanceService({ agentDir, attachmentsDir, workspaceDir: join(root, 'ws'), worktreesRoot: join(root, 'wt'), workspaceRepoPath: root } as never, prisma as never);
  return { root, agentDir, attachmentsDir, cache, svc };
}

describe('cache pruning (digests and fetched pages)', () => {
  it('removes only what is older than the retention — in the cache folder and next to old videos — never the video itself', async () => {
    const { root, attachmentsDir, agentDir, cache, svc } = setup();
    const r = await svc.pruneCaches();
    expect(r.digests).toBe(3);
    expect(r.research).toBe(1);
    expect(existsSync(join(cache, 'aaaa'))).toBe(false);
    expect(existsSync(join(cache, 'bbbb'))).toBe(true);
    expect(existsSync(join(attachmentsDir, 't1', 'old.mp4.digest'))).toBe(false);
    expect(existsSync(join(root, 'ws', 'work', 'clip.webm.digest'))).toBe(false);
    expect(existsSync(join(attachmentsDir, 't1', 'old.mp4'))).toBe(true);
    expect(existsSync(join(agentDir, 'research-cache', 'old.json'))).toBe(false);
    expect(existsSync(join(agentDir, 'research-cache', 'new.json'))).toBe(true);
  });
  it('the emergency relief clears every digest, but keeps recent pages', async () => {
    const { agentDir, cache, svc } = setup();
    const r = await svc.pruneCaches({ digestDays: 0, researchDays: 30 });
    expect(r.digests).toBe(4);
    expect(existsSync(join(cache, 'bbbb'))).toBe(false);
    expect(existsSync(join(agentDir, 'research-cache', 'new.json'))).toBe(true);
  });
  it('never removes a digest built in the last minutes, even for the emergency relief', async () => {
    const { cache, svc } = setup();
    mkdirSync(join(cache, 'busy'), { recursive: true });
    const r = await svc.pruneCaches({ digestDays: 0 });
    expect(r.digests).toBe(4);
    expect(existsSync(join(cache, 'busy'))).toBe(true);
  });
  it('reports sizes and which caches are stale', async () => {
    const { svc } = setup();
    const c = await svc.cacheReport();
    expect(c.digests.count).toBe(4);
    expect(c.digests.stale).toBe(3);
    expect(c.research.stale).toBe(1);
  });
});

describe('attachment retention (off by default)', () => {
  const old = new Date(Date.now() - 200 * DAY);
  const tasks = [
    { id: 'done-old', status: 'completed', updatedAt: old },
    { id: 'done-new', status: 'completed', updatedAt: new Date() },
    { id: 'live-old', status: 'running', updatedAt: old },
  ];
  const withFolders = () => {
    const s = setup(tasks);
    for (const id of ['done-old', 'done-new', 'live-old', 'gone-old', 'gone-new']) {
      mkdirSync(join(s.attachmentsDir, id), { recursive: true });
      writeFileSync(join(s.attachmentsDir, id, 'f.txt'), 'x');
    }
    age(join(s.attachmentsDir, 'gone-old'), 200);
    return s;
  };
  it('does nothing unless a retention is set', async () => {
    const { attachmentsDir, svc } = withFolders();
    expect(svc.attachmentsRetentionDays).toBe(0);
    expect(await svc.pruneAttachments()).toEqual({ removed: 0, bytes: 0 });
    expect(existsSync(join(attachmentsDir, 'done-old'))).toBe(true);
    expect((await svc.report()).attachments.retentionDays).toBe(0);
  });
  it('with a retention: removes finished tasks past it and folders of deleted tasks, keeps live and recent ones', async () => {
    process.env.ATTACHMENTS_RETENTION_DAYS = '90';
    const { attachmentsDir, svc } = withFolders();
    const r = await svc.pruneAttachments();
    expect(r.removed).toBe(2);
    expect(existsSync(join(attachmentsDir, 'done-old'))).toBe(false);
    expect(existsSync(join(attachmentsDir, 'gone-old'))).toBe(false);
    for (const id of ['done-new', 'live-old', 'gone-new', 't1']) expect(existsSync(join(attachmentsDir, id)), id).toBe(true);
  });
});
