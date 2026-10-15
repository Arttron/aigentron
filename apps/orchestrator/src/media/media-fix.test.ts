import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseProbe } from './media-core';
import { remuxWebm } from './media-fix';

const pexec = promisify(execFile);
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), 'fix-'))));
afterEach(() => rm(dir, { recursive: true, force: true }));

const probe = async (f: string) => parseProbe(JSON.parse((await pexec('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f])).stdout));

describe.skipIf(!hasFfmpeg)('remuxWebm (needs ffmpeg)', () => {
  it('gives a streamed webm (no length in the header, like MediaRecorder output) a length, without re-encoding', async () => {
    // writing to a pipe makes ffmpeg unable to seek back → no duration, exactly like a browser recording
    const { stdout } = await pexec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=d=2:s=64x48:r=10', '-c:v', 'libvpx', '-f', 'webm', '-'], { encoding: 'buffer', maxBuffer: 10_000_000 });
    const f = join(dir, 'clip.webm');
    await writeFile(f, stdout);
    expect(await probe(f)).toBeNull();
    const size = await remuxWebm(f);
    expect(size).toBe((await stat(f)).size);
    expect((await probe(f))?.durationSec).toBeCloseTo(2, 0);
  });

  it('leaves a file that is not a video untouched', async () => {
    const f = join(dir, 'x.webm');
    await writeFile(f, 'not a video');
    expect(await remuxWebm(f)).toBeNull();
    expect((await stat(f)).size).toBe(11);
  });
});
