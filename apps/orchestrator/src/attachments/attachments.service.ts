import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, access, writeFile, copyFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
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

  /** List a task's attachments (newest first). */
  async list(taskId: string): Promise<AttachmentMeta[]> {
    let files: string[];
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
    return metas
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
    const path = join(this.dir(taskId), name);
    try {
      await access(path);
    } catch {
      throw new BadRequestException('attachment not found');
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
    return (await this.list(taskId)).map((m) => join(dir, m.name));
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
function sanitize(rawName: string): string {
  const base = basename(rawName).replace(/[^\w.\- ]+/g, '_').trim();
  return base.length ? base.slice(0, 120) : 'file';
}
