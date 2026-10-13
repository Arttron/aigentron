import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, PayloadTooLargeException, type OnModuleInit } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { appendFile, copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { insideRoot } from '../media/media-core';
import {
  BRIEF_FILE,
  BRIEF_TEMPLATE,
  MAX_BRIEF_BYTES,
  TOP_FOLDERS,
  canDelete,
  canWrite,
  serveKind,
  MAX_MEMORY_FILE_BYTES,
  MAX_NOTE_CHARS,
  MAX_SAVE_BYTES,
  MEMORY_FILES,
  NOTE_KINDS,
  buildDigest,
  cleanText,
  formatNote,
  matchesGlob,
  human,
  memoryHeader,
  orientationBlock,
  resolveQuestion,
  safeRelative,
  type NoteKind,
} from './workspace-core';

const FOLDERS = ['memory', 'work', 'deliverables'] as const;
type Folder = (typeof FOLDERS)[number];

/**
 * The shared workspace: one folder with a standard structure (`memory/`, `work/`, `deliverables/`, `WORKSPACE.md`)
 * next to the project repository. Agents record decisions, keep drafts and save results here with the
 * `workspace_*` tools; the code repository is untouched. Later every project gets such a folder.
 */
@Injectable()
export class WorkspaceService implements OnModuleInit {
  private readonly logger = new Logger(WorkspaceService.name);
  /** Memory files are appended/rewritten one operation at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: AppConfigService) {}

  get root(): string {
    return this.config.workspaceDir;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureLayout().catch((e) => this.logger.warn(`workspace folder not ready (${this.root}): ${(e as Error).message}`));
  }

  /** Creates what is missing; never overwrites. */
  async ensureLayout(): Promise<void> {
    for (const f of FOLDERS) await mkdir(join(this.root, f), { recursive: true });
    await this.createIfMissing(join(this.root, 'WORKSPACE.md'), BRIEF_TEMPLATE);
    for (const k of NOTE_KINDS) await this.createIfMissing(join(this.root, 'memory', MEMORY_FILES[k]), memoryHeader(k));
  }

  private async createIfMissing(path: string, content: string): Promise<void> {
    await writeFile(path, content, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(path: string): Promise<string> {
    return readFile(path, 'utf8').catch(() => '');
  }

  /** The memory block for the prompt (empty when nothing has been written yet). */
  async digest(): Promise<string> {
    const m = (k: NoteKind) => this.read(join(this.root, 'memory', MEMORY_FILES[k]));
    const [brief, status, decisions, questions] = await Promise.all([this.read(join(this.root, 'WORKSPACE.md')), m('status'), m('decision'), m('question')]);
    const body = buildDigest({ brief, status, decisions, questions });
    return body ? `## Workspace memory (what the team already knows — read before you start)\n${body}` : '';
  }

  /** The orientation block of the prompt. */
  orientation(): string {
    return orientationBlock(this.root);
  }

  async info(): Promise<string> {
    await this.ensureLayout();
    const digest = await this.digest();
    return [
      orientationBlock(this.root),
      '',
      digest || 'Memory is empty so far — record decisions and open questions with `workspace_note`.',
    ].join('\n');
  }

  /** Appends a note (or replaces the status). Returns the text shown to the agent. */
  async note(input: { kind: string; text: string; resolves?: string }, by?: string): Promise<string> {
    const kind = input.kind as NoteKind;
    if (!NOTE_KINDS.includes(kind)) throw new Error(`kind must be one of: ${NOTE_KINDS.join(', ')}.`);
    const text = cleanText(input.text ?? '');
    if (!text) throw new Error('The note is empty.');
    if (text.length > MAX_NOTE_CHARS) throw new Error(`The note is too long (${text.length} characters, the limit is ${MAX_NOTE_CHARS}) — make it shorter and keep long material in a file in work/.`);
    return this.serial(async () => {
      await this.ensureLayout();
      const file = join(this.root, 'memory', MEMORY_FILES[kind]);
      if (kind === 'status') {
        await writeFile(file, `${memoryHeader('status')}\n${text}\n`);
        return 'Status updated.';
      }
      const size = (await stat(file).catch(() => ({ size: 0 }))).size;
      if (size > MAX_MEMORY_FILE_BYTES) throw new Error(`memory/${MEMORY_FILES[kind]} is full (${human(size)}) — ask the person to consolidate it.`);
      let resolved = '';
      await appendFile(file, formatNote(kind, text, new Date(), by));
      if (input.resolves) {
        const qfile = join(this.root, 'memory', MEMORY_FILES.question);
        const updated = resolveQuestion(await this.read(qfile), input.resolves);
        if (updated !== null) {
          await writeFile(qfile, updated);
          resolved = ' The matching open question is marked answered.';
        } else {
          resolved = ' (No open question matched "resolves".)';
        }
      }
      return `Recorded in memory/${MEMORY_FILES[kind]}.${resolved}`;
    });
  }

  /** The person's answer to ask_user goes to decisions.md by itself. Never throws. */
  async recordAnswer(question: string, answer: string): Promise<void> {
    try {
      const q = cleanText(question).slice(0, 300);
      const a = cleanText(answer).slice(0, 600);
      if (!q || !a) return;
      await this.note({ kind: 'decision', text: `[asked the person] ${q} → ${a}` });
    } catch (e) {
      this.logger.warn(`could not record an answer: ${(e as Error).message}`);
    }
  }

  /** Saves a result into deliverables/. `from` must be a file of this task (attachments / workspace / `allowFrom`). */
  async save(raw: { path: string; content?: string; from?: string; note?: string }, allowFrom: readonly string[] = [], onSaved?: (dest: string) => Promise<string | undefined>): Promise<string> {
    // models often send the unused argument as an empty string — that means "not given"
    const from = raw.from?.trim() ? raw.from.trim() : undefined;
    const input = { ...raw, from, content: from && !raw.content ? undefined : raw.content };
    const rel = safeRelative(input.path ?? '');
    if (!rel) throw new Error('`path` must be a relative path inside deliverables/ (no "..", no leading "/", no hidden folders).');
    if ((input.content === undefined) === (input.from === undefined)) throw new Error('Give either `content` (the text) or `from` (a file to copy), not both.');
    await this.ensureLayout();
    const dest = join(this.root, 'deliverables', rel);
    const destDir = dirname(dest);
    await mkdir(destDir, { recursive: true });
    // never follow a symlink out of deliverables/
    const realDeliverables = await realpath(join(this.root, 'deliverables'));
    const realDir = await realpath(destDir);
    if (!insideRoot(realDir, [realDeliverables])) throw new Error('That path leaves deliverables/.');

    let source: string | null = null;
    let bytes = 0;
    if (input.from !== undefined) {
      if (!input.from.startsWith('/')) throw new Error('`from` must be the full path of the file.');
      const real = await realpath(input.from).catch(() => '');
      const roots = await Promise.all([this.config.attachmentsDir, this.root, ...allowFrom].map((r) => realpath(r).catch(() => r)));
      if (!real || !insideRoot(real, roots)) throw new Error('That file is not available: copy only files of this task (attachments, workspace, the project).');
      const st = await stat(real);
      if (!st.isFile()) throw new Error('`from` is not a file.');
      if (st.size > MAX_SAVE_BYTES) throw new Error(`The file is too large (${human(st.size)}; the limit is ${human(MAX_SAVE_BYTES)}).`);
      source = real;
      bytes = st.size;
    } else {
      bytes = Buffer.byteLength(input.content ?? '');
      if (bytes > MAX_SAVE_BYTES) throw new Error(`The content is too large (${human(bytes)}).`);
    }
    return this.serial(async () => {
      const existed = await stat(dest).then((s) => s.isFile(), () => false);
      if (existed) {
        const keep = join(this.root, 'deliverables', '.versions', `${rel}.${new Date().toISOString().replace(/[:.]/g, '-')}`);
        await mkdir(dirname(keep), { recursive: true });
        await copyFile(dest, keep);
      }
      if (source) await copyFile(source, dest);
      else await writeFile(dest, input.content ?? '');
      if (input.note?.trim()) await appendFile(join(this.root, 'deliverables', '.log.md'), `- ${new Date().toISOString().slice(0, 16)}Z ${rel} — ${cleanText(input.note).slice(0, 300)}\n`).catch(() => undefined);
      // the caller may show it in the task's attachments (a link, not a copy) — never fatal
      const extra = onSaved ? await onSaved(dest).catch(() => undefined) : undefined;
      return `Saved ${human(bytes)} to ${dest}${existed ? ' (the previous version was kept)' : ''}.${extra ? ` ${extra}` : ' Mention this path to the person.'}`;
    });
  }

  /** Files of the workspace (all three folders, or one) with sizes and dates. */
  async files(input: { dir?: string; glob?: string; limit?: number } = {}): Promise<string> {
    await this.ensureLayout();
    const dirs: readonly Folder[] = input.dir && (FOLDERS as readonly string[]).includes(input.dir) ? [input.dir as Folder] : FOLDERS;
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 100), 1), 500);
    const rows: string[] = [];
    let total = 0;
    for (const d of dirs) {
      const base = join(this.root, d);
      for (const f of await walk(base, 6)) {
        const rel = relative(base, f.path);
        if (input.glob && !matchesGlob(input.glob, rel)) continue;
        total++;
        if (rows.length < limit) rows.push(`${d}/${rel}  ${human(f.size)}  ${f.mtime.toISOString().slice(0, 16)}Z`);
      }
    }
    if (!total) return `No files${input.glob ? ` matching ${input.glob}` : ''} in ${dirs.join(', ')}.`;
    return `${rows.join('\n')}${total > rows.length ? `\n… and ${total - rows.length} more (narrow with dir/glob)` : ''}\nRoot: ${this.root}`;
  }

  /** Total size of the workspace in bytes (bounded walk). */
  async size(): Promise<number> {
    let sum = 0;
    for (const f of await walk(this.root, 8, 20_000)) sum += f.size;
    return sum;
  }

  // ---- dashboard file access (a person browsing the workspace) ----

  /** A path from the dashboard, checked: inside the workspace, in a known top folder, no hidden parts, no symlink out. */
  private async resolve(rel: string, opts: { mustExist: boolean }): Promise<{ rel: string; abs: string }> {
    const clean = rel === '' ? '' : safeRelative(rel);
    if (clean === null) throw new BadRequestException('Bad path.');
    if (clean !== '') {
      const top = clean.split('/')[0]!;
      if (clean !== BRIEF_FILE && !(TOP_FOLDERS as readonly string[]).includes(top)) throw new NotFoundException('Not found.');
    }
    const abs = join(this.root, clean);
    const realRoot = await realpath(this.root).catch(() => this.root);
    // the deepest existing ancestor must be inside the workspace for real (no symlink out)
    let probe = abs;
    for (;;) {
      const real = await realpath(probe).catch(() => null);
      if (real) {
        if (!insideRoot(real, [realRoot])) throw new ForbiddenException('That path leaves the workspace.');
        break;
      }
      const up = dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    if (opts.mustExist && !(await stat(abs).catch(() => null))) throw new NotFoundException('Not found.');
    return { rel: clean, abs };
  }

  /** Entries of a folder (the workspace root when `rel` is empty). */
  async list(rel: string): Promise<{ path: string; entries: { name: string; dir: boolean; size: number; mtime: string }[]; writable: boolean }> {
    await this.ensureLayout();
    const { rel: clean, abs } = await this.resolve(rel, { mustExist: true });
    const st = await stat(abs);
    if (!st.isDirectory()) throw new BadRequestException('Not a folder.');
    const names = await readdir(abs).catch(() => [] as string[]);
    const entries: { name: string; dir: boolean; size: number; mtime: string }[] = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      if (clean === '' && name !== BRIEF_FILE && !(TOP_FOLDERS as readonly string[]).includes(name)) continue;
      const s = await stat(join(abs, name)).catch(() => null);
      if (s) entries.push({ name, dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: s.mtime.toISOString() });
    }
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { path: clean, entries, writable: clean === 'work' || clean.startsWith('work/') };
  }

  /** A file to serve: its path and how to serve it. */
  async fileForServing(rel: string): Promise<{ abs: string; name: string; size: number } & ReturnType<typeof serveKind>> {
    const { rel: clean, abs } = await this.resolve(rel, { mustExist: true });
    const st = await stat(abs);
    if (!st.isFile()) throw new BadRequestException('Not a file.');
    const name = clean.split('/').pop()!;
    return { abs, name, size: st.size, ...serveKind(name) };
  }

  /** Upload / overwrite a file: only inside work/ (and the brief). */
  async writeUpload(rel: string, source: Readable): Promise<{ path: string; size: number }> {
    await this.ensureLayout();
    const { rel: clean, abs } = await this.resolve(rel, { mustExist: false });
    if (!clean || !canWrite(clean)) throw new ForbiddenException('You can add or change files only in work/ (and edit WORKSPACE.md).');
    if (clean === 'work') throw new BadRequestException('Give a file name.');
    const limit = clean === BRIEF_FILE ? MAX_BRIEF_BYTES : MAX_SAVE_BYTES;
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.part-${process.pid}-${Date.now()}`;
    const out = createWriteStream(tmp);
    let size = 0;
    try {
      for await (const chunk of source) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new PayloadTooLargeException(`The file is too large (limit ${human(limit)}).`);
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'finish');
      await rename(tmp, abs);
    } catch (e) {
      // wait for the stream to close first: destroying before it has opened would create the file right after rm
      await new Promise<void>((resolve) => {
        out.once('close', () => resolve());
        out.destroy();
      });
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    return { path: clean, size };
  }

  /** Delete one file in work/ or deliverables/ (never memory, never the brief). */
  async remove(rel: string): Promise<void> {
    const { rel: clean, abs } = await this.resolve(rel, { mustExist: true });
    if (!canDelete(clean)) throw new ForbiddenException('Files can be deleted only in work/ and deliverables/.');
    const st = await stat(abs);
    if (!st.isFile()) throw new BadRequestException('Only files can be deleted.');
    await rm(abs, { force: true });
  }

  /** Counts and sizes for the dashboard header and the disk report. */
  async summary(): Promise<{ root: string; bytes: number; folders: Record<string, { files: number; bytes: number }> }> {
    await this.ensureLayout();
    const folders: Record<string, { files: number; bytes: number }> = {};
    let bytes = 0;
    for (const f of FOLDERS) {
      const files = await walk(join(this.root, f), 8, 20_000);
      const b = files.reduce((a, x) => a + x.size, 0);
      folders[f] = { files: files.length, bytes: b };
      bytes += b;
    }
    return { root: this.root, bytes, folders };
  }

  /** Absolute folders agents may write to besides the task root. */
  get writeRoots(): string[] {
    return [resolve(this.root)];
  }
}

async function walk(dir: string, depth: number, cap = 5000): Promise<{ path: string; size: number; mtime: Date }[]> {
  const out: { path: string; size: number; mtime: Date }[] = [];
  const visit = async (d: string, left: number): Promise<void> => {
    if (out.length >= cap) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // .versions, .log.md …
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (left > 0) await visit(p, left - 1);
      } else if (e.isFile()) {
        const st = await stat(p).catch(() => null);
        if (st) out.push({ path: p, size: st.size, mtime: st.mtime });
      }
      if (out.length >= cap) return;
    }
  };
  await visit(dir, depth);
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}
