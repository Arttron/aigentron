import { mkdir, readdir, readFile, rm, stat, lstat, access, writeFile, copyFile, rename, link, unlink } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { BadRequestException, Injectable, Logger, PayloadTooLargeException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { partName, saveStream } from '../files/file-io';
import { extOf, isImage, isVideo, mimeFor, servePolicy } from '../files/file-types';
import { realInside, safeName } from '../files/fs-safe';
import { asciiFileName } from '../files/ascii-name';
import { ImageOptimizer } from '../media/image-optimizer.service';
import { remuxWebm } from '../media/media-fix';

/**
 * Any file type is accepted as an attachment (the agent's Read tool views images/PDF via vision and text formats as plain text
 * either way). How a file is SERVED comes from the shared file-types policy: pictures / PDF / playable video inline, text as
 * text/plain, everything else (html, svg, js …) as a forced download so an upload can never run as same-origin script.
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
/**
 * A video may be much bigger (a walk-through of a room…) — but not beyond what the proxy in front lets through: Cloudflare's free plan
 * refuses request bodies over 100 MB with an HTML error page. 95 MB leaves room for headers; the server says it plainly itself.
 */
export const MAX_VIDEO_UPLOAD_BYTES = 95 * 1024 * 1024;
/** All files of one task together (a runaway upload loop cannot fill the disk). */
export const TASK_QUOTA_BYTES = 1024 * 1024 * 1024;
export const limitFor = (ext: string): number => (isVideo(ext) ? MAX_VIDEO_UPLOAD_BYTES : MAX_BYTES);
/** The message for a file over its limit — says what to do, not just "too large". */
export function tooBigMessage(ext: string, limit = limitFor(ext)): string {
  const mb = Math.round(limit / 1024 / 1024);
  return isVideo(ext)
    ? `The video is larger than ${mb} MB, which is the most this server accepts (the web proxy in front of it refuses bigger uploads). Trim it, lower the resolution, or record a shorter clip.`
    : `The file is larger than ${mb} MB, which is the most this server accepts for this type of file.`;
}
const TASK_ID_RE = /^[\w-]+$/;

export interface AttachmentMeta {
  name: string;
  /** What the person called the file, when the stored name had to be turned into plain ASCII ("кухня 2.jpg" → "kukhnya-2.jpg"). */
  originalName?: string;
  size: number;
  mime: string;
}

/**
 * Per-task attachments (any file type) stored under <attachmentsDir>/<taskId>.
 * Agents view images/PDF via the Read tool's vision and read text-based
 * formats as plain text either way; the dashboard shows a gallery (images
 * inline, everything else as a generic file tile). Writes by agents into this
 * dir go through the approval gate (it's outside the worktree). Cleaned up
 * when the task is deleted.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly images: ImageOptimizer,
  ) {}

  /** Absolute directory for a task's attachments. */
  dir(taskId: string): string {
    if (!TASK_ID_RE.test(taskId)) throw new BadRequestException('invalid task id');
    return join(this.config.attachmentsDir, taskId);
  }

  /** Bytes already stored for a task (own files; links are not copies). */
  async usedBytes(taskId: string): Promise<number> {
    let sum = 0;
    for (const n of await readdir(this.dir(taskId)).catch(() => [] as string[])) {
      const st = await lstat(join(this.dir(taskId), n)).catch(() => null);
      if (st?.isFile()) sum += st.size;
    }
    return sum;
  }

  /** Stream an upload to disk, validating size — any file type is accepted. `declaredBytes` (Content-Length) lets an obviously too big upload be refused before reading a byte. */
  async save(
    taskId: string,
    rawName: string,
    source: Readable,
    declaredBytes?: number,
  ): Promise<AttachmentMeta> {
    const ext = extOf(rawName);
    const mime = mimeFor(ext);
    const dir = this.dir(taskId);
    const limit = limitFor(ext);
    if (declaredBytes !== undefined && declaredBytes > limit) throw new PayloadTooLargeException(tooBigMessage(ext, limit));
    await mkdir(dir, { recursive: true });
    const used = await this.usedBytes(taskId);
    if (used + (declaredBytes ?? 0) > TASK_QUOTA_BYTES) throw new PayloadTooLargeException(`This task already holds ${Math.round(used / 1048576)} MB of files; the limit per task is ${TASK_QUOTA_BYTES / 1048576} MB.`);

    // written under a hidden `.part` name (never listed, never served), then moved into place without overwriting anything
    const tmp = partName(join(dir, 'x'));
    let size = await saveStream(source, tmp, {
      limit,
      tooBig: () => new PayloadTooLargeException(tooBigMessage(ext, limit)),
      check: (n) => {
        if (used + n > TASK_QUOTA_BYTES) throw new PayloadTooLargeException(`The task would exceed its ${TASK_QUOTA_BYTES / 1048576} MB limit of files.`);
      },
    });
    // A clip recorded in the browser (webm) has no length in its header: copy it into a proper webm (no re-encoding; skipped without ffmpeg).
    if (ext === 'webm') size = (await remuxWebm(tmp)) ?? size;
    // what the person called it — for display and download only (never used as a path): no folders, no control characters
    const original = basename(rawName.replace(/\\/g, '/')).normalize('NFC').split('').filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('').trim().slice(0, 150) || 'file';
    const dest = await this.place(dir, tmp, asciiFileName(original)).catch(async (e) => {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    });
    const name = basename(dest);
    // A phone photo is 4000 px and several MB: shrink it to what the agents need (a PNG may become a JPEG → the name can change).
    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      const r = await this.images.optimize(dest, undefined, false, (d, n) => this.uniqueName(d, n));
      if (r.changed) {
        const finalName = basename(r.path);
        this.logger.log(`Saved attachment ${taskId}/${finalName} (${r.size}B, was ${size}B)`);
        // the optimizer may have changed the extension (a PNG photo became a JPEG): the shown name follows it
        const shown = original.replace(/\.[^.]+$/, '') + extname(finalName);
        const kept = await this.rememberOriginal(dir, finalName, shown);
        return { name: finalName, size: r.size, mime: mimeFor(finalName), ...(kept ? { originalName: kept } : {}) };
      }
    }
    this.logger.log(`Saved attachment ${taskId}/${name} (${size}B)`);
    const kept = await this.rememberOriginal(dir, name, original);
    return { name, size, mime, ...(kept ? { originalName: kept } : {}) };
  }

  private namesFile(dir: string): string {
    return join(dir, '.names.json');
  }

  /** stored name → the name the person gave (only for files whose stored name differs). */
  private async readNames(dir: string): Promise<Record<string, string>> {
    try {
      const raw = JSON.parse(await readFile(this.namesFile(dir), 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return {};
      return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private namesChain = new Map<string, Promise<unknown>>();

  /** Remember the original name of a stored file when it differs; returns it (or null when there is nothing to remember). */
  private async rememberOriginal(dir: string, stored: string, original: string): Promise<string | null> {
    // only names that had to be converted to ASCII are remembered (a "-1" added to avoid a clash is not an original worth showing)
    if (stored === original || asciiFileName(original) === original) return null;
    const run = (this.namesChain.get(dir) ?? Promise.resolve()).then(async () => {
      const names = await this.readNames(dir);
      names[stored] = original;
      const tmp = `${this.namesFile(dir)}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(names));
      await rename(tmp, this.namesFile(dir));
    });
    this.namesChain.set(dir, run.catch(() => undefined));
    await run.catch(() => undefined);
    return original;
  }

  /** Move a finished temp file to `<dir>/<wanted>` (or `-1`, `-2` … when taken), never replacing an existing file — also not when two uploads race. */
  private async place(dir: string, tmp: string, wanted: string): Promise<string> {
    const taken = new Set(Object.keys(await this.readLinksAt(dir)));
    const ext = extname(wanted);
    for (let n = 0; n < 1000; n++) {
      const name = n === 0 ? wanted : `${basename(wanted, ext)}-${n}${ext}`;
      if (taken.has(name)) continue;
      const dest = join(dir, name);
      try {
        await link(tmp, dest); // fails with EEXIST instead of overwriting
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        // a filesystem without hard links: the best remaining option
        if (await access(dest).then(() => true, () => false)) continue;
        await rename(tmp, dest);
        return dest;
      }
      await unlink(tmp).catch(() => undefined);
      return dest;
    }
    throw new BadRequestException('too many files with that name');
  }

  /** Copy an existing picture (a generated image in the workspace, a library resource …) into the task's attachments so the chat can show it. Returns the stored name. */
  async adopt(taskId: string, srcPath: string): Promise<string> {
    const ext = extOf(srcPath);
    if (!isImage(ext)) throw new BadRequestException(`"${basename(srcPath)}" is not a picture I can show (png, jpg, webp, gif).`);
    const dir = this.dir(taskId);
    await mkdir(dir, { recursive: true });
    const stat0 = await lstat(srcPath); // not stat: a symlink (or a hard link to a file elsewhere) must never be followed into a copy of something private
    if (!stat0.isFile() || stat0.nlink !== 1) throw new BadRequestException(`"${basename(srcPath)}" is not a plain picture file.`);
    if (stat0.size > MAX_BYTES * 3) throw new PayloadTooLargeException(`"${basename(srcPath)}" is too large to show.`);
    // the same picture shown again (an agent calls show_images twice on one file) is the file already there, not a second copy
    const same = await this.sameContent(dir, srcPath, stat0.size);
    if (same) return same;
    const name = await this.uniqueName(dir, sanitize(basename(srcPath)));
    const dest = join(dir, name);
    await copyFile(srcPath, dest);
    const r = ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? await this.images.optimize(dest, undefined, false, (d, n) => this.uniqueName(d, n)) : { path: dest, changed: false };
    return basename(r.path);
  }

  /** The name of a file already in `dir` with exactly this content (same size first, then the hash), or null. */
  private async sameContent(dir: string, srcPath: string, size: number): Promise<string | null> {
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => !n.startsWith('.'));
    let srcHash: string | null = null;
    for (const n of names) {
      const st = await stat(join(dir, n)).catch(() => null);
      if (!st || !st.isFile() || st.size !== size) continue;
      srcHash ??= createHash('sha256').update(await readFile(srcPath)).digest('hex');
      const h = createHash('sha256').update(await readFile(join(dir, n))).digest('hex');
      if (h === srcHash) return n;
    }
    return null;
  }

  /**
   * Write a base64 image (e.g. an MCP screenshot the agent produced) as a task
   * attachment under a caller-chosen filename, so it surfaces in the gallery and
   * inline in the transcript. Best-effort caller — validates type/size.
   */
  async writeImage(taskId: string, filename: string, base64: string): Promise<void> {
    const name = sanitize(filename);
    if (!isImage(name)) throw new BadRequestException('unsupported image type');
    if (Math.floor((base64.length * 3) / 4) > MAX_BYTES) throw new PayloadTooLargeException(`image exceeds ${MAX_BYTES / 1024 / 1024}MB`); // before decoding: no big allocation for a refused image
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > MAX_BYTES) throw new PayloadTooLargeException(`image exceeds ${MAX_BYTES / 1024 / 1024}MB`);
    const dir = this.dir(taskId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, name);
    const tmp = join(dir, `.${randomBytes(6).toString('hex')}.part`);
    await writeFile(tmp, buf);
    await rename(tmp, file); // never visible half-written
    await this.images.optimize(file, undefined, true).catch(() => undefined); // a screenshot never needs to be 4K
    this.logger.log(`Saved screenshot ${taskId}/${name} (${buf.length}B)`);
  }

  // ---- linked attachments: a task's attachment list may point at files that live elsewhere (no copy) ----

  /** Folders a link may point into: the shared workspace, the project folders and the resource library. */
  private linkRoots(): string[] {
    return [this.config.workspaceDir, this.config.projectsDir, join(this.config.agentDir, 'resources')].filter(Boolean);
  }

  private linksFile(taskId: string): string {
    return join(this.dir(taskId), '.links.json');
  }

  private readLinks(taskId: string): Promise<Record<string, string>> {
    return this.readLinksAt(this.dir(taskId));
  }

  private async readLinksAt(dir: string): Promise<Record<string, string>> {
    try {
      const raw = JSON.parse(await readFile(join(dir, '.links.json'), 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return {};
      return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** The real path of a link target, only while it still is a file inside an allowed folder (checked again on every use). */
  private resolveLink(src: string): Promise<string | null> {
    return realInside(src, this.linkRoots(), { file: true });
  }

  private linkChain = new Map<string, Promise<unknown>>();

  /**
   * Show a file that lives elsewhere (a workspace result, a library file) in this task's attachments WITHOUT copying it.
   * The list, the gallery, the viewer and the channels treat it like any attachment; it always shows the file's current content,
   * and disappears from the list if the source is deleted. Returns the name it is listed under.
   */
  async link(taskId: string, src: string): Promise<string> {
    if (!src.startsWith('/')) throw new BadRequestException('a link needs a full path');
    const real = await this.resolveLink(src);
    if (!real) throw new BadRequestException('that file cannot be attached (it must be a file of the workspace or the library)');
    const run = (this.linkChain.get(taskId) ?? Promise.resolve()).then(async () => {
      const dir = this.dir(taskId);
      await mkdir(dir, { recursive: true });
      const links = await this.readLinks(taskId);
      const existing = Object.entries(links).find(([, p]) => p === real);
      if (existing) return existing[0];
      let name = sanitize(basename(real));
      for (let n = 1; (await access(join(dir, name)).then(() => true, () => false)) || name in links; n++) {
        const ext = extname(basename(real));
        name = `${sanitize(basename(real, ext))}-${n}${ext}`;
      }
      links[name] = real;
      const tmp = `${this.linksFile(taskId)}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(links));
      await rename(tmp, this.linksFile(taskId));
      return name;
    });
    this.linkChain.set(taskId, run.catch(() => undefined));
    return run;
  }

  /** List a task's attachments (newest first): its own files plus linked ones (a link whose source is gone is skipped). */
  async list(taskId: string): Promise<AttachmentMeta[]> {
    let files: string[] = [];
    try {
      files = await readdir(this.dir(taskId));
    } catch {
      return [];
    }
    const names = await this.readNames(this.dir(taskId));
    const metas = await Promise.all(
      files.filter((n) => !n.startsWith('.')).map(async (name) => {
        // lstat: a symlink dropped into the folder is not one of the task's files (it is never served either)
        const s = await lstat(join(this.dir(taskId), name)).catch(() => null);
        return s && s.isFile() ? { name, size: s.size, mime: mimeFor(name), mtime: s.mtimeMs, ...(names[name] ? { originalName: names[name] } : {}) } : null;
      }),
    );
    const linked = await Promise.all(
      Object.entries(await this.readLinks(taskId)).map(async ([name, src]) => {
        const real = await this.resolveLink(src);
        const s = real ? await stat(real).catch(() => null) : null;
        return s ? { name, size: s.size, mime: mimeFor(name), mtime: s.mtimeMs } : null;
      }),
    );
    const own = new Set(metas.filter((m): m is NonNullable<typeof m> => m !== null).map((m) => m.name));
    return [...metas, ...linked.filter((m) => m && !own.has(m.name))]
      .filter((m): m is AttachmentMeta & { mtime: number } => m !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ mtime: _mtime, ...m }) => m);
  }

  /** Resolve a safe absolute path for serving a single file, with how to serve it (`mime`, `inline` — the shared file-types policy).
   *  `name` is the sanitized filename actually on disk — always safe to embed in a Content-Disposition header, unlike the raw request param. */
  async filePath(
    taskId: string,
    rawName: string,
  ): Promise<{ path: string; mime: string; inline: boolean; name: string; downloadName: string }> {
    if (basename(rawName).startsWith('.')) throw new BadRequestException('attachment not found'); // `.links.json` is never a downloadable attachment
    const name = sanitize(rawName);
    const dir = this.dir(taskId);
    // a name like ".." must never resolve to a folder, and a symlink placed in the folder must never lead out of it: only regular files of the task
    let path = await realInside(join(dir, name), [dir], { file: true });
    if (!path) {
      // not one of its own files: a linked one?
      const src = (await this.readLinks(taskId))[name];
      path = src ? await this.resolveLink(src) : null;
      if (!path) throw new BadRequestException('attachment not found');
    }
    const { mime, inline } = servePolicy(name);
    // downloads keep the name the person gave the file
    const downloadName = (await this.readNames(dir))[name] ?? name;
    return { path, mime, inline, name, downloadName };
  }

  /** Remove all of a task's attachments (called on task delete). */
  async remove(taskId: string): Promise<void> {
    if (!TASK_ID_RE.test(taskId)) return;
    await rm(this.dir(taskId), { recursive: true, force: true }).catch(() => undefined);
  }

  /** stored name → the name the person gave it (only for converted names), for prompts and display. */
  async originalNames(taskId: string): Promise<Record<string, string>> {
    return this.readNames(this.dir(taskId));
  }

  /** Absolute paths of a task's attachments, for prompting the agent. */
  async paths(taskId: string): Promise<string[]> {
    const dir = this.dir(taskId);
    const links = await this.readLinks(taskId);
    const own = (name: string) => access(join(dir, name)).then(() => true, () => false);
    return Promise.all((await this.list(taskId)).map(async (m) => (links[m.name] && !(await own(m.name)) ? links[m.name]! : join(dir, m.name))));
  }

  private async uniqueName(dir: string, name: string): Promise<string> {
    let candidate = name;
    let n = 1;
    const links = await this.readLinksAt(dir); // a name used by a link counts as taken too
    while (true) {
      if (!(candidate in links)) {
        try {
          await access(join(dir, candidate));
        } catch {
          return candidate;
        }
      }
      const ext = extname(name);
      candidate = `${basename(name, ext)}-${n++}${ext}`;
    }
  }
}

/** Reduce an upload name to a safe basename (unicode kept, no path, no leading dot) — `safeName` of fs-safe. */
export const sanitize = safeName;
