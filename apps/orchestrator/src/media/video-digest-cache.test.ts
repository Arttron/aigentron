import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import { VideoService, digestDirFor, legacyDigestDir } from './video.service';

let base: string;
let svc: VideoService;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vd-'));
  await mkdir(join(base, 'agent'), { recursive: true });
  svc = new VideoService({ sttReady: () => false } as never, { agentDir: join(base, 'agent') } as AppConfigService);
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe('digest cache location', () => {
  it('lives under <agentDir>/cache/digests/<hash of the path>, never next to the video', () => {
    const d = digestDirFor('/data/agent', '/data/workspace/work/clip.mp4');
    expect(d.startsWith('/data/agent/cache/digests/')).toBe(true);
    expect(d.split('/').pop()).toMatch(/^[0-9a-f]{32}$/);
    expect(digestDirFor('/data/agent', '/data/workspace/work/clip.mp4')).toBe(d);
    expect(digestDirFor('/data/agent', '/data/workspace/work/other.mp4')).not.toBe(d);
    expect(svc.digestDir('/x/v.mp4')).toBe(digestDirFor(join(base, 'agent'), '/x/v.mp4'));
  });

  it('a digest left next to the video by an older version is moved into the cache with its paths rewritten', async () => {
    const video = join(base, 'ws', 'room.mp4');
    const old = legacyDigestDir(video);
    await mkdir(old, { recursive: true });
    await writeFile(video, 'VIDEO');
    await writeFile(join(old, 'frame-01.jpg'), 'jpg');
    await writeFile(join(old, 'frames.json'), JSON.stringify([{ t: 1, path: join(old, 'frame-01.jpg') }]));
    await writeFile(join(old, 'digest.md'), `Video: room.mp4\n- 0:01 → ${join(old, 'frame-01.jpg')}\n`);
    await writeFile(join(old, 'meta.json'), JSON.stringify({ id: 'x', plan: 'p' }));
    await svc.adoptLegacy(video);
    const dir = svc.digestDir(video);
    expect(existsSync(old)).toBe(false);
    expect((await readdir(dir)).sort()).toEqual(['digest.md', 'frame-01.jpg', 'frames.json', 'meta.json']);
    expect(JSON.parse(await readFile(join(dir, 'frames.json'), 'utf8'))).toEqual([{ t: 1, path: join(dir, 'frame-01.jpg') }]);
    expect(await readFile(join(dir, 'digest.md'), 'utf8')).toContain(join(dir, 'frame-01.jpg'));
    expect(await readFile(join(dir, 'digest.md'), 'utf8')).not.toContain('.digest/');
    expect(existsSync(video)).toBe(true);
  });

  it('an old folder is simply dropped when the cache already has a digest', async () => {
    const video = join(base, 'ws', 'room.mp4');
    const old = legacyDigestDir(video);
    await mkdir(old, { recursive: true });
    await writeFile(join(old, 'meta.json'), JSON.stringify({ id: 'old', plan: 'p' }));
    const dir = svc.digestDir(video);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ id: 'new', plan: 'p' }));
    await svc.adoptLegacy(video);
    expect(existsSync(old)).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')).id).toBe('new');
  });

  it('does nothing when there is no old folder', async () => {
    await svc.adoptLegacy(join(base, 'none.mp4'));
    expect(existsSync(join(base, 'agent', 'cache'))).toBe(false);
  });
});
