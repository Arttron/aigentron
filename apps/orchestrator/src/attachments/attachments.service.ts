import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, access, writeFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { BadRequestException, Injectable, Logger, PayloadTooLargeException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/** Allowed upload types (Claude Code's Read tool can view all of these). */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
};
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const TASK_ID_RE = /^[\w-]+$/;

export interface AttachmentMeta {
  name: string;
  size: number;
  mime: string;
}

/**
 * Per-task image/PDF attachments stored under <attachmentsDir>/<taskId>. Agents
 * read them via the Read tool (vision); the dashboard shows a gallery. Writes
 * by agents into this dir go through the approval gate (it's outside the
 * worktree). Cleaned up when the task is deleted.
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

  /** Stream an upload to disk, validating extension and size. */
  async save(
    taskId: string,
    rawName: string,
    source: Readable,
  ): Promise<AttachmentMeta> {
    const ext = extname(rawName).slice(1).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      throw new BadRequestException(`unsupported file type: .${ext || '?'} (allowed: ${Object.keys(MIME_BY_EXT).join(', ')})`);
    }
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
    if (!MIME_BY_EXT[ext] || ext === 'pdf') throw new BadRequestException('unsupported image type');
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
        const mime = MIME_BY_EXT[ext];
        if (!mime) return null;
        const s = await stat(join(this.dir(taskId), name)).catch(() => null);
        return s && s.isFile() ? { name, size: s.size, mime, mtime: s.mtimeMs } : null;
      }),
    );
    return metas
      .filter((m): m is AttachmentMeta & { mtime: number } => m !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ mtime: _mtime, ...m }) => m);
  }

  /** Resolve a safe absolute path for serving a single file. */
  async filePath(taskId: string, rawName: string): Promise<{ path: string; mime: string }> {
    const name = sanitize(rawName);
    const ext = extname(name).slice(1).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) throw new BadRequestException('unsupported file type');
    const path = join(this.dir(taskId), name);
    try {
      await access(path);
    } catch {
      throw new BadRequestException('attachment not found');
    }
    return { path, mime };
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
