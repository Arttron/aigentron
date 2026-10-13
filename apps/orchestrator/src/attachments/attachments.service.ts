import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rm, stat, access, writeFile, copyFile } from 'node:fs/promises';
import { join, basename, extname, resolve, sep } from 'node:path';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { BadRequestException, Injectable, Logger, PayloadTooLargeException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ImageOptimizer } from '../media/image-optimizer.service';

/**
 * Rendered/served inline as their real type — safe because a browser can only
 * ever display or download these, never execute script from them. Everything
 * else is still accepted (any file type is allowed as an attachment — the
 * agent's Read tool can view images/PDF via vision and text-based formats as
 * plain text either way), but is served as a forced download instead (see
 * filePath()/the controller) so an uploaded `.html`/`.svg`/`.js` can't run as
 * same-origin script just by opening its attachment URL.
 */
const INLINE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
};
/** Best-effort Content-Type for common non-inline formats — cosmetic (the
 *  file still force-downloads either way), just nicer than a blanket
 *  octet-stream for things like a .json/.csv reference file. */
const KNOWN_MIME_BY_EXT: Record<string, string> = {
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  log: 'text/plain',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Content-Type for any extension — known-safe types get their real MIME,
 *  everything else falls back to a generic binary type (still fine to store
 *  and download, just not rendered as anything specific). */
function mimeFor(ext: string): string {
  return INLINE_MIME_BY_EXT[ext] ?? KNOWN_MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Whether this extension is safe to serve inline (vs. forced download). */
function isInlineSafe(ext: string): boolean {
  return ext in INLINE_MIME_BY_EXT;
}

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
/** A video may be much bigger (a walk-through of a room…). */
const MAX_VIDEO_BYTES_ATT = 300 * 1024 * 1024;
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', '3gp']);
const limitFor = (ext: string): number => (VIDEO_EXTS.has(ext) ? MAX_VIDEO_BYTES_ATT : MAX_BYTES);
const TASK_ID_RE = /^[\w-]+$/;

export interface AttachmentMeta {
  name: string;
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

  /** Stream an upload to disk, validating size — any file type is accepted. */
  async save(
    taskId: string,
    rawName: string,
    source: Readable,
  ): Promise<AttachmentMeta> {
    const ext = extname(rawName).slice(1).toLowerCase();
    const mime = mimeFor(ext);
    const dir = this.dir(taskId);
    await mkdir(dir, { recursive: true });
    const name = await this.uniqueName(dir, sanitize(rawName));
    const dest = join(dir, name);

    const out = createWriteStream(dest);
    let size = 0;
    try {
      for await (const chunk of source) {
        size += (chunk as Buffer).length;
        if (size > limitFor(ext)) throw new PayloadTooLargeException(`file exceeds ${limitFor(ext) / 1024 / 1024}MB`);
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'finish');
    } catch (e) {
      out.destroy();
      await rm(dest, { force: true }).catch(() => undefined);
      throw e;
    }
    // A phone photo is 4000 px and several MB: shrink it to what the agents need (a PNG may become a JPEG → the name can change).
    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      const r = await this.images.optimize(dest, undefined, false, (d, n) => this.uniqueName(d, n));
      if (r.changed) {
        const finalName = basename(r.path);
        this.logger.log(`Saved attachment ${taskId}/${finalName} (${r.size}B, was ${size}B)`);
        return { name: finalName, size: r.size, mime: mimeFor(extname(finalName).slice(1).toLowerCase()) };
      }
    }
    this.logger.log(`Saved attachment ${taskId}/${name} (${size}B)`);
    return { name, size, mime };
  }

  /** Copy an existing picture (a generated image in the workspace, a library resource …) into the task's attachments so the chat can show it. Returns the stored name. */
  async adopt(taskId: string, srcPath: string): Promise<string> {
    const ext = extname(srcPath).slice(1).toLowerCase();
    if (!INLINE_MIME_BY_EXT[ext] || ext === 'pdf') throw new BadRequestException(`"${basename(srcPath)}" is not a picture I can show (png, jpg, webp, gif).`);
    const dir = this.dir(taskId);
    await mkdir(dir, { recursive: true });
    const stat0 = await stat(srcPath);
    if (stat0.size > MAX_BYTES * 3) throw new PayloadTooLargeException(`"${basename(srcPath)}" is too large to show.`);
    const name = await this.uniqueName(dir, sanitize(basename(srcPath)));
    const dest = join(dir, name);
    await copyFile(srcPath, dest);
    const r = ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? await this.images.optimize(dest, undefined, false, (d, n) => this.uniqueName(d, n)) : { path: dest, changed: false };
    return basename(r.path);
  }

  /**
   * Write a base64 image (e.g. an MCP screenshot the agent produced) as a task
   * attachment under a caller-chosen filename, so it surfaces in the gallery and
   * inline in the transcript. Best-effort caller — validates type/size.
   */
  async writeImage(taskId: string, filename: string, base64: string): Promise<void> {
    const name = sanitize(filename);
    const ext = extname(name).slice(1).toLowerCase();
    if (!INLINE_MIME_BY_EXT[ext] || ext === 'pdf') throw new BadRequestException('unsupported image type');
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > MAX_BYTES) throw new PayloadTooLargeException(`image exceeds ${MAX_BYTES / 1024 / 1024}MB`);
    const dir = this.dir(taskId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, name);
    await writeFile(file, buf);
    await this.images.optimize(file, undefined, true).catch(() => undefined); // a screenshot never needs to be 4K
    this.logger.log(`Saved screenshot ${taskId}/${name} (${buf.length}B)`);
  }

  // ---- linked attachments: a task's attachment list may point at files that live elsewhere (no copy) ----

  /** Folders a link may point into: the shared workspace and the resource library. */
  private linkRoots(): string[] {
    return [this.config.workspaceDir, join(this.config.agentDir, 'resources')].filter(Boolean);
  }

  private linksFile(taskId: string): string {
    return join(this.dir(taskId), '.links.json');
  }

  private async readLinks(taskId: string): Promise<Record<string, string>> {
    try {
      const raw = JSON.parse(await readFile(this.linksFile(taskId), 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return {};
      return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** The real path of a link target, only while it still is a file inside an allowed folder (checked again on every use). */
  private async resolveLink(src: string): Promise<string | null> {
    const real = await realpath(src).catch(() => null);
    if (!real) return null;
    const roots = await Promise.all(this.linkRoots().map((r) => realpath(r).catch(() => resolve(r))));
    if (!roots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))) return null;
    const st = await stat(real).catch(() => null);
    return st?.isFile() ? real : null;
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
      await writeFile(this.linksFile(taskId), JSON.stringify(links));
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
    const metas = await Promise.all(
      files.filter((n) => !n.startsWith('.')).map(async (name) => {
        const ext = extname(name).slice(1).toLowerCase();
        const s = await stat(join(this.dir(taskId), name)).catch(() => null);
        return s && s.isFile() ? { name, size: s.size, mime: mimeFor(ext), mtime: s.mtimeMs } : null;
      }),
    );
    const linked = await Promise.all(
      Object.entries(await this.readLinks(taskId)).map(async ([name, src]) => {
        const real = await this.resolveLink(src);
        const s = real ? await stat(real).catch(() => null) : null;
        return s ? { name, size: s.size, mime: mimeFor(extname(name).slice(1).toLowerCase()), mtime: s.mtimeMs } : null;
      }),
    );
    const own = new Set(metas.filter((m): m is NonNullable<typeof m> => m !== null).map((m) => m.name));
    return [...metas, ...linked.filter((m) => m && !own.has(m.name))]
      .filter((m): m is AttachmentMeta & { mtime: number } => m !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ mtime: _mtime, ...m }) => m);
  }

  /** Resolve a safe absolute path for serving a single file. `inline` tells
   *  the controller whether it's safe to render directly (image/PDF) or must
   *  be forced to download (everything else — see INLINE_MIME_BY_EXT above).
   *  `name` is the sanitized filename actually on disk — always safe to embed
   *  in a Content-Disposition header, unlike the raw request param. */
  async filePath(
    taskId: string,
    rawName: string,
  ): Promise<{ path: string; mime: string; inline: boolean; name: string }> {
    const name = sanitize(rawName);
    const ext = extname(name).slice(1).toLowerCase();
    let path = join(this.dir(taskId), name);
    try {
      await access(path);
    } catch {
      // not one of its own files: a linked one?
      const src = (await this.readLinks(taskId))[name];
      const real = src ? await this.resolveLink(src) : null;
      if (!real) throw new BadRequestException('attachment not found');
      path = real;
    }
    return { path, mime: mimeFor(ext), inline: isInlineSafe(ext), name };
  }

  /** Remove all of a task's attachments (called on task delete). */
  async remove(taskId: string): Promise<void> {
    if (!TASK_ID_RE.test(taskId)) return;
    await rm(this.dir(taskId), { recursive: true, force: true }).catch(() => undefined);
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
    while (true) {
      try {
        await access(join(dir, candidate));
      } catch {
        return candidate;
      }
      const ext = extname(name);
      candidate = `${basename(name, ext)}-${n++}${ext}`;
    }
  }
}

/** Reduce an upload name to a safe basename (no path traversal, ascii-ish). */
export function sanitize(rawName: string): string {
  // letters / digits / marks of ANY script are kept (a photo called "кухня 2.jpg" or "写真.jpg" must stay readable); only path/odd characters go
  const base = basename(rawName).normalize('NFC').replace(/[^\p{L}\p{N}\p{M}.\-_ ]+/gu, '_').trim();
  return base.length ? base.slice(0, 120) : 'file';
}
