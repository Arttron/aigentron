import { mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MaintenanceService } from './maintenance.service';

const DAY = 86_400_000;
const age = (path: string, days: number) => {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(path, t, t);
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mt-'));
  const agentDir = join(root, 'agent');
  const attachmentsDir = join(agentDir, 'attachments');
  mkdirSync(join(attachmentsDir, 't1', 'old.mp4.digest'), { recursive: true });
  mkdirSync(join(attachmentsDir, 't1', 'new.mp4.digest'), { recursive: true });
  writeFileSync(join(attachmentsDir, 't1', 'old.mp4.digest', 'frame.jpg'), 'x'.repeat(1000));
  writeFileSync(join(attachmentsDir, 't1', 'new.mp4.digest', 'frame.jpg'), 'x'.repeat(1000));
  writeFileSync(join(attachmentsDir, 't1', 'old.mp4'), 'VIDEO');
  mkdirSync(join(agentDir, 'research-cache'), { recursive: true });
  writeFileSync(join(agentDir, 'research-cache', 'old.json'), '{}');
  writeFileSync(join(agentDir, 'research-cache', 'new.json'), '{}');
  age(join(attachmentsDir, 't1', 'old.mp4.digest'), 60);
  age(join(agentDir, 'research-cache', 'old.json'), 400);
  const svc = new MaintenanceService({ agentDir, attachmentsDir, worktreesRoot: join(root, 'wt'), workspaceRepoPath: root } as never, { task: { findMany: async () => [] } } as never);
  return { root, agentDir, attachmentsDir, svc };
}

describe('cache pruning (digests and fetched pages)', () => {
  it('removes only what is older than the retention, never the video itself', async () => {
    const { root, attachmentsDir, agentDir, svc } = setup();
    const r = await svc.pruneCaches();
    expect(r.digests).toBe(1);
    expect(r.research).toBe(1);
    expect(existsSync(join(attachmentsDir, 't1', 'old.mp4.digest'))).toBe(false);
    expect(existsSync(join(attachmentsDir, 't1', 'new.mp4.digest'))).toBe(true);
    expect(existsSync(join(attachmentsDir, 't1', 'old.mp4'))).toBe(true);
    expect(existsSync(join(agentDir, 'research-cache', 'old.json'))).toBe(false);
    expect(existsSync(join(agentDir, 'research-cache', 'new.json'))).toBe(true);
    rmSync(root, { recursive: true });
  });
  it('the emergency relief clears every digest, but keeps recent pages', async () => {
    const { root, attachmentsDir, agentDir, svc } = setup();
    const r = await svc.pruneCaches({ digestDays: 0, researchDays: 30 });
    expect(r.digests).toBe(2);
    expect(existsSync(join(attachmentsDir, 't1', 'new.mp4.digest'))).toBe(false);
    expect(existsSync(join(agentDir, 'research-cache', 'new.json'))).toBe(true);
    rmSync(root, { recursive: true });
  });
  it('reports sizes and which caches are stale', async () => {
    const { root, svc } = setup();
    const c = await svc.cacheReport();
    expect(c.digests.count).toBe(2);
    expect(c.digests.stale).toBe(1);
    expect(c.research.stale).toBe(1);
    rmSync(root, { recursive: true });
  });
});
