import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import { MediaService } from './media.service';

let base: string;
let svc: MediaService;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'safe-'));
  for (const d of ['attachments/tA', 'attachments/tB', 'ws', 'agent/resources']) await mkdir(join(base, d), { recursive: true });
  await writeFile(join(base, 'attachments/tA/a.txt'), 'a');
  await writeFile(join(base, 'attachments/tB/b.txt'), 'b');
  svc = new MediaService({ attachmentsDir: join(base, 'attachments'), workspaceDir: join(base, 'ws'), agentDir: join(base, 'agent') } as AppConfigService, {} as never, {} as never);
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe('safePath with a task id', () => {
  it('allows this task\'s attachments only, not another task\'s', async () => {
    await expect(svc.safePath(join(base, 'attachments/tA/a.txt'), undefined, 'tA')).resolves.toContain('a.txt');
    await expect(svc.safePath(join(base, 'attachments/tB/b.txt'), undefined, 'tA')).rejects.toThrow(/not available/);
  });
  it('still allows the workspace and extra roots', async () => {
    await writeFile(join(base, 'ws/r.txt'), 'r');
    await expect(svc.safePath(join(base, 'ws/r.txt'), undefined, 'tA')).resolves.toContain('r.txt');
  });
  it('rejects a task id that is a path', async () => {
    await expect(svc.safePath(join(base, 'attachments/tB/b.txt'), undefined, '../tB')).rejects.toThrow();
  });
});
