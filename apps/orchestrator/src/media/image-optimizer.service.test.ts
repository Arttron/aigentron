import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImageOptimizer } from './image-optimizer.service';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)('ImageOptimizer (needs ffmpeg)', () => {
  const make = (dir: string, name: string, size: string, extra: string[] = []) =>
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}`, '-frames:v', '1', ...extra, join(dir, name)]);
  const dims = (file: string) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();

  it('shrinks a big photo in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opt-'));
    make(dir, 'big.jpg', '4000x3000', ['-q:v', '2']);
    const before = readFileSync(join(dir, 'big.jpg')).length;
    const r = await new ImageOptimizer().optimize(join(dir, 'big.jpg'));
    expect(r.changed).toBe(true);
    expect(r.size).toBeLessThan(before);
    expect(dims(r.path)).toBe('1600,1200');
    rmSync(dir, { recursive: true });
  });

  it('a PNG that becomes a JPEG never overwrites a JPEG of the same name, and no temp files stay in the folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opt-'));
    make(dir, 'photo.png', '2400x1600');
    writeFileSync(join(dir, 'photo.jpg'), 'ANOTHER PICTURE');
    const unique = async (d: string, name: string) => (existsSync(join(d, name)) ? name.replace(/\.(\w+)$/, '-2.$1') : name);
    const r = await new ImageOptimizer().optimize(join(dir, 'photo.png'), 1600, false, unique);
    expect(r.changed).toBe(true);
    expect(r.path.endsWith('photo-2.jpg')).toBe(true);
    expect(readFileSync(join(dir, 'photo.jpg'), 'utf8')).toBe('ANOTHER PICTURE');
    expect(readdirSync(dir).sort()).toEqual(['photo-2.jpg', 'photo.jpg']);
    rmSync(dir, { recursive: true });
  });

  it('leaves a small picture and a non-image alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opt-'));
    make(dir, 'small.jpg', '320x200');
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    const o = new ImageOptimizer();
    expect((await o.optimize(join(dir, 'small.jpg'))).changed).toBe(false);
    expect((await o.optimize(join(dir, 'notes.txt'))).changed).toBe(false);
    rmSync(dir, { recursive: true });
  });
});
