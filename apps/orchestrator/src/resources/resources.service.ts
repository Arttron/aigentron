import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { BadRequestException, Injectable, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import {
  MAX_FILE_BYTES,
  MAX_RESOURCES,
  MAX_TEXT_BYTES,
  MAX_TOTAL_BYTES,
  appliesTo,
  cleanTags,
  kindFor,
  mimeFor,
  promptBlock,
  safeFileName,
  titleFromName,
  search,
  searchReport,
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

/**
 * The project's resource library — files kept under `<agentDir>/resources/` with a small index. Agents get the list in their
 * prompt and read the files with their normal Read tool; people manage them in the dashboard. A plain, file-based stand-in
 * for a knowledge base (a real one can read the same files later).
 */
@Injectable()
export class ResourcesService {
  private readonly logger = new Logger(ResourcesService.name);
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: AppConfigService) {}

  private get root(): string {
    return join(this.config.agentDir, 'resources');
  }
  private get filesDir(): string {
    return join(this.root, 'files');
  }
  private get indexFile(): string {
    return join(this.root, 'index.json');
  }

  /** Absolute path of the stored file — what agents are told to Read. */
  pathOf(r: Pick<ResourceEntry, 'file'>): string {
    return join(this.filesDir, r.file);
  }

  /** Serialize index changes (read-modify-write) so concurrent requests cannot lose each other's edits. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<ResourceEntry[]> {
    try {
      const j = JSON.parse(await readFile(this.indexFile, 'utf8')) as { items?: ResourceEntry[] };
      return Array.isArray(j.items) ? j.items : [];
    } catch {
      return [];
    }
  }

  private async write(items: ResourceEntry[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ items }, null, 2));
    await rename(tmp, this.indexFile);
  }

  async list(): Promise<ResourceEntry[]> {
    return (await this.read()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ResourceEntry> {
    const r = (await this.read()).find((x) => x.id === id);
    if (!r) throw new NotFoundException(`Resource not found: ${id}`);
    return r;
  }

  async usage(): Promise<{ count: number; bytes: number; maxCount: number; maxBytes: number }> {
    const items = await this.read();
    return { count: items.length, bytes: items.reduce((n, r) => n + r.size, 0), maxCount: MAX_RESOURCES, maxBytes: MAX_TOTAL_BYTES };
  }

  private async room(extraBytes: number): Promise<void> {
    const u = await this.usage();
    if (u.count >= MAX_RESOURCES) throw new BadRequestException(`The library is full (${MAX_RESOURCES} resources) — delete something first.`);
    if (u.bytes + extraBytes > MAX_TOTAL_BYTES) throw new PayloadTooLargeException(`The library would exceed ${MAX_TOTAL_BYTES / 1024 / 1024} MB — delete something first.`);
  }

  private meta(m: ResourceMeta, fallbackTitle: string): { title: string; description: string; tags: string[]; agents: string[] } {
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
    const meta = this.meta(m, '');
    return this.locked(async () => {
      await this.room(Buffer.byteLength(text));
      const id = this.newId();
      const file = `${id}-${safeFileName(`${meta.title}.md`)}`;
      await mkdir(this.filesDir, { recursive: true });
      await writeFile(join(this.filesDir, file), text);
      const now = new Date().toISOString();
      const entry: ResourceEntry = { id, ...meta, kind: 'text', file, originalName: `${meta.title}.md`, mime: 'text/markdown', size: Buffer.byteLength(text), source: m.source ?? 'note', createdAt: now, updatedAt: now };
      await this.write([...(await this.read()), entry]);
      this.logger.log(`Resource note "${meta.title}" (${entry.size}B)`);
      return entry;
    });
  }

  /** A file uploaded as the raw request body. */
  async upload(rawName: string, source: Readable, m: ResourceMeta = {}): Promise<ResourceEntry> {
    const ext = extname(rawName).slice(1).toLowerCase();
    const name = safeFileName(rawName);
    const meta = this.meta(m, titleFromName(rawName));
    const id = this.newId();
    const file = `${id}-${name}`;
    await mkdir(this.filesDir, { recursive: true });
    const dest = join(this.filesDir, file);
    const out = createWriteStream(dest);
    let size = 0;
    try {
      for await (const chunk of source) {
        size += (chunk as Buffer).length;
        if (size > MAX_FILE_BYTES) throw new PayloadTooLargeException(`the file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB`);
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'finish');
      if (size === 0) throw new BadRequestException('the file is empty.');
      return await this.locked(async () => {
        await this.room(size);
        const now = new Date().toISOString();
        const entry: ResourceEntry = { id, ...meta, kind: kindFor(ext), file, originalName: rawName.split(/[\\/]/).pop() ?? name, mime: mimeFor(ext), size, source: m.source ?? 'upload', createdAt: now, updatedAt: now };
        await this.write([...(await this.read()), entry]);
        this.logger.log(`Resource "${meta.title}" uploaded (${size}B, ${entry.kind})`);
        return entry;
      });
    } catch (e) {
      out.destroy();
      await rm(dest, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  /** Copy a file from disk into the library (starter material of a pack). Skips when a resource with the same title exists. */
  async addFromPath(srcPath: string, m: ResourceMeta): Promise<ResourceEntry | null> {
    const ext = extname(srcPath).slice(1).toLowerCase();
    const s = await stat(srcPath);
    const stem = safeFileName(srcPath).replace(/\.[^.]+$/, '');
    const meta = this.meta(m, stem);
    return this.locked(async () => {
      if ((await this.read()).some((r) => r.title === meta.title && r.source === (m.source ?? 'upload'))) return null;
      await this.room(s.size);
      const id = this.newId();
      const file = `${id}-${safeFileName(srcPath)}`;
      await mkdir(this.filesDir, { recursive: true });
      await copyFile(srcPath, join(this.filesDir, file));
      const now = new Date().toISOString();
      const entry: ResourceEntry = { id, ...meta, kind: kindFor(ext), file, originalName: srcPath.split(/[\\/]/).pop() ?? file, mime: mimeFor(ext), size: s.size, source: m.source ?? 'upload', createdAt: now, updatedAt: now };
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
      const meta = this.meta({ title: patch.title ?? cur.title, description: patch.description ?? cur.description, tags: patch.tags ?? cur.tags, agents: patch.agents ?? cur.agents }, cur.title);
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

  /** The block for an agent's system prompt ('' when there is nothing for it). */
  async promptIndex(agentName?: string): Promise<string> {
    return promptBlock(await this.list(), (r) => this.pathOf(r), agentName);
  }

  /** `resources_search` tool answer. Scoped to what the calling agent may see. */
  async searchReport(input: { query?: string; tag?: string }, agentName?: string): Promise<string> {
    const mine = (await this.list()).filter((r) => appliesTo(r, agentName));
    return searchReport(search(mine, input.query, input.tag), (r) => this.pathOf(r));
  }
}
