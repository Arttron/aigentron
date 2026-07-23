import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, access, writeFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { BadRequestException, Injectable, Logger, PayloadTooLargeException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

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

  constructor(private readonly config: AppConfigService) {}

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
        if (size > MAX_BYTES) throw new PayloadTooLargeException(`file exceeds ${MAX_BYTES / 1024 / 1024}MB`);
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'finish');
    } catch (e) {
      out.destroy();
      await rm(dest, { force: true }).catch(() => undefined);
      throw e;
    }
    this.logger.log(`Saved attachment ${taskId}/${name} (${size}B)`);
    return { name, size, mime };
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
    await writeFile(join(dir, name), buf);
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
      files.map(async (name) => {
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
