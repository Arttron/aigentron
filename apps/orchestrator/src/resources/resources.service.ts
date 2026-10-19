import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { AppConfigService } from '../config/app-config.service';
import { ImageOptimizer } from '../media/image-optimizer.service';
import { PrismaService } from '../prisma/prisma.service';
import { projectDirOf } from '../projects/project-context';
import { ResourceLibrary, type LibraryUsage, type ResourceMeta } from './resource-library';
import { appliesTo, promptBlock, search, searchReport, type ResourceEntry } from './resources-core';

export type { LibraryUsage, ResourceMeta } from './resource-library';

/** `all` = the global library and every project's; `global` = the global one only; a slug = that project's library only. */
export type ResourceScope = 'all' | 'global' | string;

/** The `project` of a request: a slug, or `global` / empty / null for the global library. */
export const scopeOf = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s !== 'global' ? s : null;
};

/**
 * The resource libraries. The GLOBAL one is `<agentDir>/resources` (every task of every project sees it); each project has its
 * own under `<project dir>/library` (the default project's: `<WORKSPACE_DIR>/library`), seen only by that project's tasks.
 * Items are addressed by id across all libraries (ids are random and never reused). Agents get the index in their prompt and
 * read the files with their normal Read tool; people manage them in the dashboard.
 */
@Injectable()
export class ResourcesService {
  private readonly logger = new Logger(ResourcesService.name);
  private readonly global: ResourceLibrary;
  private readonly projectLibs = new Map<string, ResourceLibrary>();

  constructor(
    private readonly config: AppConfigService,
    private readonly images: ImageOptimizer,
    private readonly prisma: PrismaService,
  ) {
    this.global = new ResourceLibrary(join(config.agentDir, 'resources'), null, images);
  }

  /** The library folder of a project row (`<project dir>/library`). */
  libraryDirOf(p: { slug: string; isDefault: boolean }): string {
    return join(projectDirOf(p, this.config), 'library');
  }

  private forProject(p: { slug: string; isDefault: boolean }): ResourceLibrary {
    const dir = this.libraryDirOf(p);
    const have = this.projectLibs.get(p.slug);
    if (have && have.root === dir) return have;
    const lib = new ResourceLibrary(dir, p.slug, this.images);
    this.projectLibs.set(p.slug, lib);
    return lib;
  }

  /** The global library (null / `global`) or a project's (by slug; 404 for an unknown project). */
  async library(project: string | null | undefined): Promise<ResourceLibrary> {
    const slug = scopeOf(project);
    if (!slug) return this.global;
    const row = await this.prisma.project.findUnique({ where: { slug }, select: { slug: true, isDefault: true } });
    if (!row) throw new NotFoundException(`Project "${slug}" not found`);
    return this.forProject(row);
  }

  /** The libraries a scope covers: global + a project's (a task's view), `all`, `global`, or one slug. */
  private async libraries(scope: ResourceScope): Promise<ResourceLibrary[]> {
    if (scope === 'global') return [this.global];
    if (scope === 'all') {
      const rows = await this.prisma.project.findMany({ select: { slug: true, isDefault: true }, orderBy: { slug: 'asc' } });
      return [this.global, ...rows.map((r) => this.forProject(r))];
    }
    return [await this.library(scope)];
  }

  /** What a task of a project sees: its project's library and the global one (never another project's). */
  private async forTask(project: string | null | undefined): Promise<ResourceLibrary[]> {
    const own = scopeOf(project) ? await this.library(project).catch(() => null) : null;
    return own ? [own, this.global] : [this.global];
  }

  /** Absolute path of the stored file — what agents are told to Read. */
  async pathOf(r: Pick<ResourceEntry, 'file' | 'project'>): Promise<string> {
    return (await this.library(r.project)).pathOf(r);
  }

  /** Where an id lives (searched across all libraries). */
  private async locate(id: string): Promise<{ lib: ResourceLibrary; entry: ResourceEntry }> {
    for (const lib of await this.libraries('all')) {
      const entry = await lib.find(id);
      if (entry) return { lib, entry };
    }
    throw new NotFoundException(`Resource not found: ${id}`);
  }

  /** Newest first; project items keep their `project` slug, global ones have null. */
  async list(scope: ResourceScope = 'all'): Promise<ResourceEntry[]> {
    const all = await Promise.all((await this.libraries(scope)).map((l) => l.list()));
    return all.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ResourceEntry> {
    return (await this.locate(id)).entry;
  }

  /** The usage of ONE library (`all` → the global one, as before). */
  async usage(scope: ResourceScope = 'global'): Promise<LibraryUsage> {
    const lib = scope === 'all' || scope === 'global' ? this.global : await this.library(scope);
    return lib.usage();
  }

  /** A text note written in the dashboard / by the admin (stored as Markdown), into the global library or a project's. */
  async createNote(m: ResourceMeta & { text: string; project?: string | null }): Promise<ResourceEntry> {
    const lib = await this.library(m.project);
    const r = await lib.createNote(m);
    this.logger.log(`Resource note "${r.title}" (${r.size}B${r.project ? `, project ${r.project}` : ''})`);
    return r;
  }

  /** A file uploaded as the raw request body. */
  async upload(rawName: string, source: Readable, m: ResourceMeta & { project?: string | null } = {}, declaredBytes?: number): Promise<ResourceEntry> {
    const lib = await this.library(m.project);
    const r = await lib.upload(rawName, source, m, declaredBytes);
    this.logger.log(`Resource "${r.title}" uploaded (${r.size}B, ${r.kind}${r.project ? `, project ${r.project}` : ''})`);
    return r;
  }

  /** Copy a file from disk into a library (starter material of a pack). Null when a resource with the same title and source exists there. */
  async addFromPath(srcPath: string, m: ResourceMeta, project?: string | null): Promise<ResourceEntry | null> {
    return (await this.library(project)).addFromPath(srcPath, m);
  }

  /** Metadata / text changes; `project` (a slug or null = global) moves the item to another library. */
  async update(id: string, patch: ResourceMeta & { text?: string; project?: string | null }): Promise<ResourceEntry> {
    const { lib, entry } = await this.locate(id);
    const { project, ...rest } = patch;
    let cur = Object.keys(rest).length ? await lib.update(id, rest) : entry;
    if (project !== undefined && scopeOf(project) !== cur.project) cur = await this.move(lib, cur, scopeOf(project));
    return cur;
  }

  private async move(from: ResourceLibrary, r: ResourceEntry, to: string | null): Promise<ResourceEntry> {
    const target = await this.library(to);
    if (target === from) return r;
    const moved = await target.adopt(from, r);
    await from.remove(r.id); // the file is already gone from there; only the entry is dropped
    this.logger.log(`Resource "${r.title}" moved ${r.project ?? 'global'} → ${moved.project ?? 'global'}`);
    return moved;
  }

  async remove(id: string): Promise<void> {
    const { lib } = await this.locate(id);
    await lib.remove(id);
  }

  /** Text of a text resource (for the editor). */
  async text(id: string): Promise<string> {
    const { lib } = await this.locate(id);
    return lib.text(id);
  }

  /** The items a task of `project` sees, with the library each came from (for paths). */
  private async taskView(project: string | null | undefined): Promise<{ items: ResourceEntry[]; pathOf: (r: ResourceEntry) => string }> {
    const libs = await this.forTask(project);
    const items = (await Promise.all(libs.map((l) => l.list()))).flat();
    const byScope = new Map(libs.map((l) => [l.project, l]));
    return { items, pathOf: (r) => (byScope.get(r.project) ?? this.global).pathOf(r) };
  }

  /** The block for an agent's system prompt ('' when there is nothing for it): the task's project library first, then the global one. */
  async promptIndex(agentName?: string, project?: string | null): Promise<string> {
    const { items, pathOf } = await this.taskView(project);
    return promptBlock(items, pathOf, agentName);
  }

  /** `resources_search` tool answer. Scoped to what the calling agent may see: its project's library and the global one. */
  async searchReport(input: { query?: string; tag?: string }, agentName?: string, project?: string | null): Promise<string> {
    const { items, pathOf } = await this.taskView(project);
    const mine = items.filter((r) => appliesTo(r, agentName));
    return searchReport(search(mine, input.query, input.tag), pathOf);
  }

  // ---- a project's library as a whole (project deletion) ----

  /** How many items a project's library holds (0 when it has none yet). */
  async countOf(p: { slug: string; isDefault: boolean }): Promise<number> {
    return (await this.forProject(p).read()).length;
  }

  /**
   * The project is being deleted: `keep` moves every item into the global library (the files under `files/<slug>/`, the
   * project's slug added as a tag so they stay findable), `delete` removes the library. The folder is gone afterwards either way.
   */
  async releaseProject(p: { slug: string; isDefault: boolean }, mode: 'keep' | 'delete'): Promise<{ moved: number; deleted: number }> {
    if (p.isDefault) throw new BadRequestException('the default project cannot be deleted');
    const lib = this.forProject(p);
    const items = await lib.read();
    let moved = 0;
    let failed = 0;
    if (mode === 'keep') {
      for (const r of items) {
        const tags = r.tags.includes(p.slug) || r.tags.length >= 12 ? r.tags : [...r.tags, p.slug];
        try {
          await this.global.adopt(lib, { ...r, tags }, p.slug);
          moved++;
        } catch (e) {
          failed++;
          this.logger.warn(`resource "${r.title}" of project "${p.slug}" could not be moved: ${(e as Error).message}`);
        }
      }
    }
    // a file that could not be moved stays where it is (the folder is kept) — nothing is lost silently
    if (!failed) await rm(lib.root, { recursive: true, force: true });
    this.projectLibs.delete(p.slug);
    this.logger.log(`Library of project "${p.slug}": ${mode === 'keep' ? `${moved} item(s) moved to the global library${failed ? `, ${failed} left in place` : ''}` : `${items.length} item(s) deleted`}`);
    return { moved, deleted: mode === 'keep' ? 0 : items.length };
  }
}
