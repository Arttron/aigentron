import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, basename } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { planImage, type ImageFacts } from './media-core';

const pexec = promisify(execFile);

/** The longest side agents need: bigger pictures are downscaled by the model APIs anyway (Claude ≈ 1568 px). Override: IMAGE_MAX_SIDE. */
export const ATTACHMENT_MAX_SIDE = Math.max(640, parseInt(process.env.IMAGE_MAX_SIDE ?? '1600', 10) || 1600);
/** Library pictures are reference material people also look at — a little more room. */
export const RESOURCE_MAX_SIDE = Math.max(ATTACHMENT_MAX_SIDE, 2000);

/**
 * Shrinks an uploaded picture to what is needed: longest side ≤ max, re-encoded (JPEG ≈ 85 %, PNG with transparency stays PNG),
 * EXIF/GPS dropped, rotation applied. Best-effort — without ffmpeg, or when the result is not smaller, the original stays.
 */
@Injectable()
export class ImageOptimizer {
  private readonly logger = new Logger('Images');
  private ok: boolean | null = null;

  private async available(): Promise<boolean> {
    if (this.ok === null) this.ok = await pexec('ffmpeg', ['-version'], { timeout: 5000 }).then(() => true, () => false);
    return this.ok;
  }

  private async facts(path: string, bytes: number): Promise<ImageFacts | null> {
    try {
      const { stdout } = await pexec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt,nb_frames', '-of', 'json', path], { timeout: 15_000 });
      const s = (JSON.parse(stdout) as { streams?: { width?: number; height?: number; pix_fmt?: string; nb_frames?: string }[] }).streams?.[0];
      if (!s?.width || !s.height) return null;
      return { ext: extname(path).slice(1), width: s.width, height: s.height, bytes, hasAlpha: /rgba|bgra|argb|abgr|yuva|ya8|ya16|gbrap|pal8/.test(s.pix_fmt ?? ''), frames: Number(s.nb_frames) > 0 ? Number(s.nb_frames) : 1 };
    } catch {
      return null;
    }
  }

  /** Optimise the file in place; returns the final path (the extension changes when a PNG became a JPEG) and size. */
  async optimize(
    path: string,
    maxSide: number = ATTACHMENT_MAX_SIDE,
    keepExt = false,
    /** Picks the final file name when the extension changes (a PNG became a JPEG) so it never overwrites another file. */
    uniqueName?: (dir: string, name: string) => Promise<string>,
  ): Promise<{ path: string; size: number; changed: boolean }> {
    const before = (await stat(path)).size;
    const same = { path, size: before, changed: false };
    try {
      if (!(await this.available())) return same;
      const facts = await this.facts(path, before);
      if (!facts) return same;
      const plan = planImage(facts, maxSide);
      if (plan.action === 'skip') return same;
      // the caller already knows the file by this name (an agent's screenshot): same format, just smaller
      if (keepExt) {
        const e = extname(path).slice(1).toLowerCase();
        if (e === 'png') plan.toExt = 'png';
        else if (e === 'jpg' || e === 'jpeg') plan.toExt = 'jpg';
        else return same;
      }
      const work = await mkdtemp(join(tmpdir(), 'lds-img-')); // never inside the attachments folder: nobody may pick up a half-written file
      const out = join(work, `out.${plan.toExt}`);
      try {
        const filter = `scale='if(gt(iw,ih),min(${plan.maxSide},iw),-2)':'if(gt(iw,ih),-2,min(${plan.maxSide},ih))'`;
        const args = ['-hide_banner', '-loglevel', 'error', '-i', path, '-map_metadata', '-1', '-vf', filter, '-frames:v', '1', ...(plan.toExt === 'jpg' ? ['-q:v', '4'] : ['-compression_level', '9']), '-y', out];
        await pexec('ffmpeg', args, { timeout: 60_000 });
        const after = (await stat(out)).size;
        if (after >= before * 0.95) return same;
        const sameFormat = plan.toExt === extname(path).slice(1).toLowerCase() || (plan.toExt === 'jpg' && /jpe?g$/i.test(path));
        let finalPath = path;
        if (!sameFormat) {
          const wanted = `${basename(path, extname(path))}.${plan.toExt}`;
          finalPath = join(dirname(path), uniqueName ? await uniqueName(dirname(path), wanted) : wanted);
        }
        await copyFile(out, finalPath); // (a rename could cross file systems)
        if (finalPath !== path) await rm(path, { force: true });
        this.logger.log(`Image ${basename(path)}: ${Math.round(before / 1024)} KB → ${Math.round(after / 1024)} KB (${facts.width}×${facts.height}, max ${plan.maxSide})`);
        return { path: finalPath, size: after, changed: true };
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (e) {
      this.logger.warn(`Could not optimise ${basename(path)}: ${(e as Error).message.slice(0, 120)}`);
      return same;
    }
  }
}
