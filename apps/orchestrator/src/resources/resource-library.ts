import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { saveUpload } from '../files/file-io';
import type { ImageOptimizer } from '../media/image-optimizer.service';
import { RESOURCE_MAX_SIDE } from '../media/image-optimizer.service';
import {
  maxBytesFor,
  MAX_RESOURCES,
  MAX_TEXT_BYTES,
  MAX_TOTAL_BYTES,
  cleanTags,
  kindFor,
  mimeFor,
  safeFileName,
  titleFromName,
  validateMeta,
  type ResourceEntry,
} from './resources-core';

export interface ResourceMeta {
  title?: string;
  description?: string;
  tags?: unknown;
  agents?: unknown;
  source?: string;
}

export interface LibraryUsage {
  count: number;
  bytes: number;
  maxCount: number;
  maxBytes: number;
}

/** What the library writes to its index (the `project` stamp is NOT stored — the folder says whose it is). */
type StoredEntry = Omit<ResourceEntry, 'project'>;

/**
 * One resource library: a folder with `files/` and `index.json`. The GLOBAL library is `<agentDir>/resources`; a project's is
 * `<project dir>/library`. Every library has its own limits (MAX_RESOURCES / MAX_TOTAL_BYTES) and its own write lock; items it
 * hands out carry `project` = the library's project slug (null for the global one).
 */
export class ResourceLibrary {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly root: string,
    /** The project's slug, or null for the global library. */
    readonly project: string | null,
    private readonly images: Pick<ImageOptimizer, 'optimize'>,
  ) {}

  get filesDir(): string {
    return join(this.root, 'files');
  }
  private get indexFile(): string {
    return join(this.root, 'index.json');
  }

  /** Absolute path of the stored file — what agents are told to Read. (`file` may hold a sub-folder: `<slug>/<name>` after a project was deleted.) */
  pathOf(r: Pick<ResourceEntry, 'file'>): string {
    return join(this.filesDir, r.file);
  }

  /** Serialize index changes (read-modify-write) so concurrent requests cannot lose each other's edits. */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private stamp(items: StoredEntry[]): ResourceEntry[] {
    return items.map((r) => ({ ...r, project: this.project }));
  }

  async read(): Promise<ResourceEntry[]> {
    try {
      const j = JSON.parse(await readFile(this.indexFile, 'utf8')) as { items?: StoredEntry[] };
      return this.stamp(Array.isArray(j.items) ? j.items : []);
    } catch {
      return [];
    }
  }

  async write(items: ResourceEntry[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ items: items.map(({ project: _p, ...r }) => r) }, null, 2));
    await rename(tmp, this.indexFile);
  }

  /** Does the library exist on disk at all (an index was written once)? */
  async exists(): Promise<boolean> {
    return Boolean(await stat(this.indexFile).catch(() => null));
  }

  async list(): Promise<ResourceEntry[]> {
    return (await this.read()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async find(id: string): Promise<ResourceEntry | null> {
    return (await this.read()).find((x) => x.id === id) ?? null;
  }

  async get(id: string): Promise<ResourceEntry> {
    const r = await this.find(id);
    if (!r) throw new NotFoundException(`Resource not found: ${id}`);
    return r;
  }

  async usage(): Promise<LibraryUsage> {
    const items = await this.read();
    return { count: items.length, bytes: items.reduce((n, r) => n + r.size, 0), maxCount: MAX_RESOURCES, maxBytes: MAX_TOTAL_BYTES };
  }

  private get label(): string {
    return this.project ? `The library of project "${this.project}"` : 'The library';
  }

  private async room(extraBytes: number): Promise<void> {
    const u = await this.usage();
    if (u.count >= MAX_RESOURCES) throw new BadRequestException(`${this.label} is full (${MAX_RESOURCES} resources) — delete something first.`);
    if (u.bytes + extraBytes > MAX_TOTAL_BYTES) throw new PayloadTooLargeException(`${this.label} would exceed ${MAX_TOTAL_BYTES / 1024 / 1024} MB — delete something first.`);
  }

  static meta(m: ResourceMeta, fallbackTitle: string): { title: string; description: string; tags: string[]; agents: string[] } {
    const title = (m.title ?? fallbackTitle).trim();
    const bad = validateMeta({ title, description: m.description });
    if (bad) throw new BadRequestException(bad);
    return {
      title,
      description: (m.description ?? '').trim(),
      tags: cleanTags(m.tags),
      agents: Array.isArray(m.agents) ? Array.from(new Set(m.agents.map((a) => String(a).trim()).filter(Boolean))).slice(0, 30) : [],
    };
  }

  private newId(): string {
    return `r${randomBytes(4).toString('hex')}`;
  }

  /** A text note written in the dashboard / by the admin (stored as Markdown). */
  async createNote(m: ResourceMeta & { text: string }): Promise<ResourceEntry> {
    const text = String(m.text ?? '');
    if (!text.trim()) throw new BadRequestException('the note is empty.');
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new PayloadTooLargeException('the note is too long (max 1 MB).');
    const meta = ResourceLibrary.meta(m, '');
    return this.locked(async () => {
      await this.room(Buffer.byteLength(text));
      const id = this.newId();
      const file = `${id}-${safeFileName(`${meta.title}.md`)}`;
      await mkdir(this.filesDir, { recursive: true });
      await writeFile(join(this.filesDir, file), text);
      const now = new Date().toISOString();
      const entry: ResourceEntry = { id, ...meta, kind: 'text', file, originalName: `${meta.title}.md`, mime: 'text/markdown', size: Buffer.byteLength(text), source: m.source ?? 'note', project: this.project, createdAt: now, updatedAt: now };
      await this.write([...(await this.read()), entry]);
      return entry;
    });
  }

  /** A file uploaded as the raw request body. */
  async upload(rawName: string, source: Readable, m: ResourceMeta = {}, declaredBytes?: number): Promise<ResourceEntry> {
    const ext = extname(rawName).slice(1).toLowerCase();
    const name = safeFileName(rawName);
    const meta = ResourceLibrary.meta(m, titleFromName(rawName));
    if (declaredBytes !== undefined && declaredBytes > maxBytesFor(kindFor(ext))) throw new PayloadTooLargeException(`the file exceeds ${maxBytesFor(kindFor(ext)) / 1024 / 1024} MB`);
    await this.room(declaredBytes ?? 0); // refuse a full library before a byte is written
    const id = this.newId();
    const file = `${id}-${name}`;
    await mkdir(this.filesDir, { recursive: true });
    const dest = join(this.filesDir, file);
    let storedFileOnDisk: string | null = null; // the optimiser may have written a different file (PNG → JPG): it must go too when we give up
    try {
      // streamed to a hidden `.part` file and moved into place: a half-sent upload is never a resource
      let size = await saveUpload(source, dest, { limit: maxBytesFor(kindFor(ext)), tooBig: (limit) => new PayloadTooLargeException(`the file exceeds ${limit / 1024 / 1024} MB`) });
      if (size === 0) throw new BadRequestException('the file is empty.');
      // library pictures: shrunk to what is needed (a PNG may become a JPEG — the stored name follows)
      let storedFile = file;
      let storedExt = ext;
      if (kindFor(ext) === 'image') {
        const r = await this.images.optimize(dest, RESOURCE_MAX_SIDE);
        if (r.changed) {
          size = r.size;
          storedFile = basename(r.path);
          storedFileOnDisk = r.path;
          storedExt = extname(r.path).slice(1).toLowerCase();
        }
      }
      return await this.locked(async () => {
        await this.room(size);
        const now = new Date().toISOString();
        const entry: ResourceEntry = { id, ...meta, kind: kindFor(storedExt), file: storedFile, originalName: storedExt === ext ? (rawName.split(/[\\/]/).pop() ?? name) : `${(rawName.split(/[\\/]/).pop() ?? name).replace(/\.[^.]+$/, '')}.${storedExt}`, mime: mimeFor(storedExt), size, source: m.source ?? 'upload', project: this.project, createdAt: now, updatedAt: now };
        await this.write([...(await this.read()), entry]);
        return entry;
      });
    } catch (e) {
      await rm(dest, { force: true }).catch(() => undefined);
      if (storedFileOnDisk) await rm(storedFileOnDisk, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  /** Copy a file from disk into the library (starter material of a pack). Skips when a resource with the same title and source exists. */
  async addFromPath(srcPath: string, m: ResourceMeta): Promise<ResourceEntry | null> {
    const ext = extname(srcPath).slice(1).toLowerCase();
    const s = await stat(srcPath);
    const stem = safeFileName(srcPath).replace(/\.[^.]+$/, '');
    const meta = ResourceLibrary.meta(m, stem);
    return this.locked(async () => {
      if ((await this.read()).some((r) => r.title === meta.title && r.source === (m.source ?? 'upload'))) return null;
      await this.room(s.size);
      const id = this.newId();
      const file = `${id}-${safeFileName(srcPath)}`;
      await mkdir(this.filesDir, { recursive: true });
      await copyFile(srcPath, join(this.filesDir, file));
      const now = new Date().toISOString();
      const entry: ResourceEntry = { id, ...meta, kind: kindFor(ext), file, originalName: srcPath.split(/[\\/]/).pop() ?? file, mime: mimeFor(ext), size: s.size, source: m.source ?? 'upload', project: this.project, createdAt: now, updatedAt: now };
      await this.write([...(await this.read()), entry]);
      return entry;
    });
  }

  async update(id: string, patch: ResourceMeta & { text?: string }): Promise<ResourceEntry> {
    return this.locked(async () => {
      const items = await this.read();
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) throw new NotFoundException(`Resource not found: ${id}`);
      const cur = items[i]!;
      const meta = ResourceLibrary.meta({ title: patch.title ?? cur.title, description: patch.description ?? cur.description, tags: patch.tags ?? cur.tags, agents: patch.agents ?? cur.agents }, cur.title);
      let size = cur.size;
      if (patch.text !== undefined) {
        if (cur.kind !== 'text') throw new BadRequestException('only text resources can be edited here.');
        if (Buffer.byteLength(patch.text) > MAX_TEXT_BYTES) throw new PayloadTooLargeException('the text is too long (max 1 MB).');
        if (!patch.text.trim()) throw new BadRequestException('the text is empty.');
        await writeFile(this.pathOf(cur), patch.text);
        size = Buffer.byteLength(patch.text);
      }
      items[i] = { ...cur, ...meta, size, updatedAt: new Date().toISOString() };
      await this.write(items);
      return items[i]!;
    });
  }

  async remove(id: string): Promise<void> {
    await this.locked(async () => {
      const items = await this.read();
      const r = items.find((x) => x.id === id);
      if (!r) throw new NotFoundException(`Resource not found: ${id}`);
      await rm(this.pathOf(r), { force: true }).catch(() => undefined);
      await this.write(items.filter((x) => x.id !== id));
    });
  }

  /** Text of a text resource (for the editor). */
  async text(id: string): Promise<string> {
    const r = await this.get(id);
    if (r.kind !== 'text') throw new BadRequestException('not a text resource.');
    return readFile(this.pathOf(r), 'utf8');
  }

  /**
   * Take an item (file + entry) from another library into this one, under `subdir` of `files/` when given (a deleted project's
   * items land in `files/<slug>/`). The id is kept unless this library already has it. Returns the entry as stored here.
   */
  async adopt(from: ResourceLibrary, r: ResourceEntry, subdir?: string): Promise<ResourceEntry> {
    const src = from.pathOf(r);
    const file = subdir ? join(subdir, basename(r.file)) : basename(r.file);
    const dest = this.pathOf({ file });
    await mkdir(dirname(dest), { recursive: true });
    await rename(src, dest).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EXDEV') throw e; // another filesystem: copy, then drop the source
      await copyFile(src, dest);
      await rm(src, { force: true });
    });
    return this.locked(async () => {
      const items = await this.read();
      const id = items.some((x) => x.id === r.id) ? this.newId() : r.id;
      const entry: ResourceEntry = { ...r, id, file, project: this.project, updatedAt: new Date().toISOString() };
      await this.write([...items, entry]);
      return entry;
    });
  }
}
