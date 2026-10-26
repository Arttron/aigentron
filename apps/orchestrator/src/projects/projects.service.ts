import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { TERMINAL_TASK_STATUSES, type Project, type TaskStatus } from '@lds/shared';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { MEMORY_FILES, NOTE_KINDS, memoryHeader, projectBriefTemplate } from '../workspace/workspace-core';
import { ResourcesService } from '../resources/resources.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { buildProjectContext, projectDirOf, projectRepoPathOf, type ProjectContext } from './project-context';
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  DEFAULT_PROJECT_SLUG,
  PROJECT_DEFAULTS,
  effectiveIsolation,
  impliedRepoAuth,
  isIsolation,
  isProjectKind,
  isRepoAuth,
  normalizeBranch,
  normalizeSubdir,
  parseRepoUrl,
  slugFromName,
  slugProblem,
  uniqueSlug,
  type ProjectIsolation,
  type ProjectKind,
  type ProjectRepoAuth, parsePinnedAgents, serializePinnedAgents } from './project-core';
import { dropProjectLabel, setProjectLabel, setProjectLabels } from './project-labels';

/** Prisma row shape for a project. */
export type ProjectRow = NonNullable<Awaited<ReturnType<PrismaService['project']['findUnique']>>>;

/** What create / update accept (validated here, whatever the transport). */
export interface ProjectInput {
  name?: string;
  slug?: string;
  kind?: string;
  repoUrl?: string | null;
  repoBranch?: string | null;
  repoSubdir?: string | null;
  repoAuth?: string | null;
  repoPath?: string | null;
  isolation?: string | null;
  verifyCommands?: string | null;
  verifyMaxAttempts?: number | null;
  defaultAgent?: string | null;
  /** agent names offered in New task (empty / null = all) */
  pinnedAgents?: string[] | null;
  notifyChannelId?: string | null;
  notifyChatId?: string | null;
}

/** Statuses that count as "active" for a project (its tasks are queued, running or waiting on a gate). */
const ACTIVE_STATUSES: TaskStatus[] = (['queued', 'running', 'needs_approval', 'review', 'done', 'failed', 'cancelled', 'blocked', 'stalled'] as TaskStatus[]).filter(
  (s) => !TERMINAL_TASK_STATUSES.includes(s),
);

/** `library/` is the project's own resource library (docs/resources.md); the dashboard uploads into it, agents only read. */
const FOLDERS = ['memory', 'work', 'deliverables', 'library'] as const;
const BRIEF_FILE = 'PROJECT.md';
const briefTemplate = projectBriefTemplate;

const MAX_NAME = 80;
const MAX_VERIFY = 4000;

/** Task counts plus the project's own library sizes (resources in `<dir>/library`, knowledge bases with its projectId). */
export type ProjectCounts = { active: number; total: number; resources: number; knowledge: number };

/** What happens to a project's own resources and knowledge bases when it is deleted (default: nothing is destroyed). */
export interface DeleteProjectOptions {
  knowledge?: 'keep' | 'delete';
  resources?: 'keep' | 'delete';
}

const keepOrDelete = (v: unknown, what: string): 'keep' | 'delete' => {
  if (v === undefined || v === null || v === '') return 'keep';
  if (v === 'keep' || v === 'delete') return v;
  throw new BadRequestException(`${what} must be "keep" or "delete"`);
};

/**
 * Projects (docs/plan-projects-workspace.md §2): a row of settings + a folder with a known layout. The default
 * project adopts the installation's existing workspace in place (WORKSPACE_REPO_PATH for its code, WORKSPACE_DIR
 * for memory / work / deliverables); every other project lives under `<PROJECTS_DIR>/<slug>/`.
 * Round 0: the data and the API only — the executor still works the one default workspace.
 */
@Injectable()
export class ProjectsService implements OnModuleInit {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Resolved lazily (the resources and knowledge services are global providers; tests may run without them). */
  private get resources(): ResourcesService | null {
    try {
      return this.moduleRef.get(ResourcesService, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }
  private get knowledge(): KnowledgeService | null {
    try {
      return this.moduleRef.get(KnowledgeService, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

  async onModuleInit(): Promise<void> {
    await this.ensureDefault().catch((e) => this.logger.error(`default project not ready: ${(e as Error).message}`));
  }

  /**
   * The default project exists (the migration creates it from AppSettings; a database started from scratch
   * gets it here) and its checkout is the configured WORKSPACE_REPO_PATH — adopted in place, nothing is copied.
   */
  async ensureDefault(): Promise<ProjectRow> {
    const repoPath = this.config.workspaceRepoPath;
    let row = await this.prisma.project.findUnique({ where: { id: DEFAULT_PROJECT_ID } });
    if (!row) {
      const s = await this.prisma.appSettings.findUnique({ where: { id: 'singleton' } }).catch(() => null);
      row = await this.prisma.project.create({
        data: {
          id: DEFAULT_PROJECT_ID,
          slug: DEFAULT_PROJECT_SLUG,
          name: DEFAULT_PROJECT_NAME,
          kind: 'code',
          isDefault: true,
          repoUrl: s?.repoUrl || null,
          repoBranch: s?.repoBranch || PROJECT_DEFAULTS.repoBranch,
          repoSubdir: normalizeSubdir(s?.workspaceSubdir) || null,
          repoAuth: s?.githubToken ? 'token' : 'none',
          repoPath,
          verifyCommands: s?.verifyCommands || null,
          verifyMaxAttempts: s?.verifyMaxAttempts ?? PROJECT_DEFAULTS.verifyMaxAttempts,
          defaultAgent: s?.defaultAgent || null,
          notifyChannelId: s?.notifyChannelId || null,
          notifyChatId: s?.notifyChatId || null,
        },
      });
      this.logger.log(`Created the default project (repo: ${repoPath})`);
    } else if (row.repoPath !== repoPath || !row.isDefault || row.archivedAt) {
      row = await this.prisma.project.update({ where: { id: DEFAULT_PROJECT_ID }, data: { repoPath, isDefault: true, archivedAt: null } });
      this.logger.log(`Default project adopts ${repoPath}`);
    }
    await this.refreshLabels();
    return row;
  }

  private async refreshLabels(): Promise<void> {
    setProjectLabels(await this.prisma.project.findMany({ select: { id: true, slug: true, name: true } }));
  }

  // ---- paths ----------------------------------------------------------------------------------------------

  /** The project's folder (memory / work / deliverables / PROJECT.md). The default project's is WORKSPACE_DIR. */
  dirOf(p: Pick<ProjectRow, 'slug' | 'isDefault'>): string {
    return projectDirOf(p, this.config);
  }

  /** The project's checkout: `repoPath` when set (the default project's is WORKSPACE_REPO_PATH), else `<dir>/repo`. */
  repoPathOf(p: Pick<ProjectRow, 'slug' | 'isDefault' | 'repoPath'>): string {
    return projectRepoPathOf(p, this.config);
  }

  // ---- runtime context (round 1: the worker / executor / provisioner read the task's project, not the global settings) ----

  /**
   * Everything the runtime needs about a task's project (docs/plan-projects-workspace.md §2.4–2.6): paths, repository,
   * effective isolation, verify commands, workspace folder, git auth reference; `defaultAgent` and the notification
   * target fall back to the global settings. By a task row (`projectId`), a slug, a project row, or nothing (= the default).
   */
  async contextFor(ref?: string | { projectId: string } | ProjectRow | null): Promise<ProjectContext> {
    const row = isProjectRow(ref) ? ref : await this.resolve(ref);
    const s = await this.prisma.appSettings.findUnique({ where: { id: 'singleton' }, select: { defaultAgent: true, notifyChannelId: true, notifyChatId: true } }).catch(() => null);
    return buildProjectContext(row, this.config, { defaultAgent: s?.defaultAgent, notifyChannelId: s?.notifyChannelId, notifyChatId: s?.notifyChatId });
  }

  /** The lead a NEW task of the project gets when none is named: the project's, else the global default. */
  async defaultAgentFor(p: Pick<ProjectRow, 'defaultAgent'>): Promise<string | null> {
    if (p.defaultAgent?.trim()) return p.defaultAgent.trim();
    const s = await this.prisma.appSettings.findUnique({ where: { id: 'singleton' }, select: { defaultAgent: true } }).catch(() => null);
    return s?.defaultAgent?.trim() || null;
  }

  /**
   * Where a task's escalation goes when it has no channel thread of its own (§2.7): the project's notification chat,
   * else the global one (Settings → Work → Escalations); null = dashboard-only.
   */
  async notifyTargetFor(taskId: string): Promise<{ channelId: string; chatId: string | null } | null> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } }).catch(() => null);
    const ctx = await this.contextFor(task ?? null).catch(() => null);
    if (!ctx?.notifyChannelId) return null;
    // `chatId: null` = the project named a channel and no chat: every chat of that channel is the project's
    return { channelId: ctx.notifyChannelId, chatId: ctx.notifyChatId };
  }

  /**
   * The project a chat is bound to (Project → Notifications): the one that names this very chat, else — when no project names it — the one that names this
   * CHANNEL without a chat (the whole channel belongs to the project). Null when none is, or when several tie (ambiguous: nothing is narrowed).
   */
  async boundToChat(channelId: string, chatId: string): Promise<ProjectRow | null> {
    if (!channelId || !chatId) return null;
    const rows = await this.prisma.project.findMany({
      // the default project never owns a chat (it carries the installation's own escalation pair, which belongs to nobody); an archived project keeps its chat
      where: { notifyChannelId: channelId, isDefault: false, OR: [{ notifyChatId: chatId }, { notifyChatId: null }, { notifyChatId: '' }] },
      take: 20,
    });
    const exact = rows.filter((r) => r.notifyChatId === chatId);
    const pick = exact.length ? exact : rows;
    if (pick.length !== 1) return null;
    setProjectLabels(pick);
    return pick[0]!;
  }

  /** Creates the folder layout that is missing (never overwrites). The default project's layout is the workspace (WorkspaceService). */
  async ensureLayout(p: Pick<ProjectRow, 'slug' | 'isDefault' | 'name'>): Promise<string> {
    const dir = this.dirOf(p);
    if (p.isDefault) return dir;
    for (const f of FOLDERS) await mkdir(join(dir, f), { recursive: true });
    await createIfMissing(join(dir, BRIEF_FILE), briefTemplate(p.name));
    for (const k of NOTE_KINDS) await createIfMissing(join(dir, 'memory', MEMORY_FILES[k]), memoryHeader(k));
    return dir;
  }

  // ---- reads ----------------------------------------------------------------------------------------------

  /** All projects (the default first, then by name); archived ones only when asked. */
  async list(opts: { includeArchived?: boolean } = {}): Promise<ProjectRow[]> {
    const rows = await this.prisma.project.findMany({
      where: opts.includeArchived ? {} : { archivedAt: null },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    setProjectLabels(rows);
    return rows;
  }

  async get(slug: string): Promise<ProjectRow> {
    const row = await this.prisma.project.findUnique({ where: { slug } });
    if (!row) throw new NotFoundException(`Project "${slug}" not found`);
    setProjectLabel(row);
    return row;
  }

  async getById(id: string): Promise<ProjectRow> {
    const row = await this.prisma.project.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Project ${id} not found`);
    setProjectLabel(row);
    return row;
  }

  async getDefault(): Promise<ProjectRow> {
    const row = await this.prisma.project.findUnique({ where: { id: DEFAULT_PROJECT_ID } });
    return row ?? this.ensureDefault();
  }

  /** The project of a task (by its row), or by slug; nothing given = the default project. */
  async resolve(taskOrSlug?: string | { projectId: string } | null): Promise<ProjectRow> {
    if (!taskOrSlug) return this.getDefault();
    if (typeof taskOrSlug === 'string') return this.get(taskOrSlug);
    return this.getById(taskOrSlug.projectId);
  }

  /**
   * The project a NEW task goes into: the given slug (must exist and not be archived), else the default.
   * An archived project takes no new work — that is what archiving means.
   */
  async forNewTask(slug?: string | null): Promise<ProjectRow> {
    if (!slug?.trim()) return this.getDefault();
    const p = await this.get(slug.trim());
    if (p.archivedAt) throw new BadRequestException(`Project "${p.slug}" is archived — unarchive it or pick another project`);
    return p;
  }

  /** How many tasks the project has, how many are active (queued / running / waiting on a gate), and its own resources / knowledge bases. */
  async counts(row: Pick<ProjectRow, 'id' | 'slug' | 'isDefault'>): Promise<ProjectCounts> {
    const [total, active, knowledge, resources] = await Promise.all([
      this.prisma.task.count({ where: { projectId: row.id } }),
      this.prisma.task.count({ where: { projectId: row.id, status: { in: ACTIVE_STATUSES } } }),
      this.prisma.knowledgeBase.count({ where: { projectId: row.id } }).catch(() => 0),
      this.resourceCount(row),
    ]);
    return { active, total, resources, knowledge };
  }

  private async resourceCount(row: Pick<ProjectRow, 'slug' | 'isDefault'>): Promise<number> {
    return (await this.resources?.countOf(row).catch(() => 0)) ?? 0;
  }

  /** Wire shape (docs/plan-projects-workspace.md §2.8) — never a secret. */
  async serialize(row: ProjectRow): Promise<Project> {
    return this.serializeWith(row, await this.counts(row));
  }

  serializeWith(row: ProjectRow, counts: ProjectCounts): Project {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind: (isProjectKind(row.kind) ? row.kind : 'code') as ProjectKind,
      isDefault: row.isDefault,
      repo: {
        url: row.repoUrl,
        branch: row.repoBranch,
        subdir: row.repoSubdir,
        auth: (isRepoAuth(row.repoAuth) ? row.repoAuth : 'none') as ProjectRepoAuth,
        path: this.repoPathOf(row),
      },
      isolation: (isIsolation(row.isolation) ? row.isolation : null) as ProjectIsolation | null,
      effectiveIsolation: effectiveIsolation(row.isolation, this.config.workspaceShared),
      verifyCommands: row.verifyCommands,
      verifyMaxAttempts: row.verifyMaxAttempts,
      defaultAgent: row.defaultAgent,
      pinnedAgents: parsePinnedAgents(row.pinnedAgents),
      notifyChannelId: row.notifyChannelId,
      notifyChatId: row.notifyChatId,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      counts,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async serializeAll(rows: ProjectRow[]): Promise<Project[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [grouped, kbs] = await Promise.all([
      this.prisma.task.groupBy({ by: ['projectId', 'status'], where: { projectId: { in: ids } }, _count: { _all: true } }),
      this.prisma.knowledgeBase.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _count: { _all: true } }).catch(() => []),
    ]);
    const counts = new Map<string, ProjectCounts>();
    const of = (id: string) => counts.get(id) ?? { active: 0, total: 0, resources: 0, knowledge: 0 };
    for (const g of grouped) {
      const c = of(g.projectId);
      c.total += g._count._all;
      if (ACTIVE_STATUSES.includes(g.status as TaskStatus)) c.active += g._count._all;
      counts.set(g.projectId, c);
    }
    for (const g of kbs) {
      if (!g.projectId) continue;
      const c = of(g.projectId);
      c.knowledge = g._count._all;
      counts.set(g.projectId, c);
    }
    for (const r of rows) {
      const c = of(r.id);
      c.resources = await this.resourceCount(r);
      counts.set(r.id, c);
    }
    return rows.map((r) => this.serializeWith(r, of(r.id)));
  }

  // ---- writes ---------------------------------------------------------------------------------------------

  async create(input: ProjectInput, createdById?: string): Promise<ProjectRow> {
    const name = cleanName(input.name);
    if (!name) throw new BadRequestException(`give the project a name (1–${MAX_NAME} characters)`);
    let slug: string;
    if (input.slug?.trim()) {
      slug = input.slug.trim();
      const bad = slugProblem(slug);
      if (bad) throw new BadRequestException(bad);
      if (await this.prisma.project.findUnique({ where: { slug }, select: { id: true } })) throw new ConflictException(`a project with slug "${slug}" already exists`);
    } else {
      const taken = new Set((await this.prisma.project.findMany({ select: { slug: true } })).map((r) => r.slug));
      slug = uniqueSlug(slugFromName(name), (s) => taken.has(s));
    }
    const fields = this.validateFields(input, null);
    const row = await this.prisma.project.create({
      data: {
        slug,
        name,
        kind: isProjectKind(input.kind) ? input.kind : PROJECT_DEFAULTS.kind,
        isDefault: false,
        ...fields,
        repoBranch: fields.repoBranch ?? PROJECT_DEFAULTS.repoBranch,
        repoAuth: fields.repoAuth ?? impliedRepoAuth(fields.repoUrl ? parseRepoUrl(fields.repoUrl) : null),
        verifyMaxAttempts: fields.verifyMaxAttempts ?? PROJECT_DEFAULTS.verifyMaxAttempts,
        createdById: createdById ?? null,
      },
    });
    setProjectLabel(row);
    await this.ensureLayout(row).catch((e) => this.logger.warn(`project folder for "${slug}" not ready: ${(e as Error).message}`));
    this.logger.log(`Created project "${slug}" (${row.kind}) → ${this.dirOf(row)}`);
    return row;
  }

  async update(slug: string, input: ProjectInput): Promise<ProjectRow> {
    const cur = await this.get(slug);
    if (input.slug !== undefined && input.slug !== cur.slug) throw new BadRequestException('the slug names the folder and cannot be changed');
    const data: Record<string, unknown> = { ...this.validateFields(input, cur) };
    if (input.name !== undefined) {
      const name = cleanName(input.name);
      if (!name) throw new BadRequestException(`give the project a name (1–${MAX_NAME} characters)`);
      data.name = name;
    }
    if (input.kind !== undefined) {
      if (!isProjectKind(input.kind)) throw new BadRequestException('kind must be "code" or "docs"');
      if (cur.isDefault && input.kind !== cur.kind) throw new BadRequestException('the default project is the code workspace — its kind cannot change');
      data.kind = input.kind;
    }
    const row = await this.prisma.project.update({ where: { id: cur.id }, data });
    setProjectLabel(row);
    if (input.name !== undefined && !row.isDefault) await this.ensureLayout(row).catch(() => undefined);
    return row;
  }

  /** An archived project takes no new tasks; its existing ones are untouched. The default project cannot be archived. */
  async archive(slug: string): Promise<ProjectRow> {
    const cur = await this.get(slug);
    if (cur.isDefault) throw new BadRequestException('the default project cannot be archived');
    if (cur.archivedAt) return cur;
    const row = await this.prisma.project.update({ where: { id: cur.id }, data: { archivedAt: new Date() } });
    this.logger.log(`Archived project "${slug}"`);
    return row;
  }

  async unarchive(slug: string): Promise<ProjectRow> {
    const cur = await this.get(slug);
    if (!cur.archivedAt) return cur;
    return this.prisma.project.update({ where: { id: cur.id }, data: { archivedAt: null } });
  }

  /**
   * Delete a project row. Refused for the default project and while the project has active tasks; its finished
   * tasks move to the default project (history is kept), its schedules let go of it (FK set-null). Its own library and
   * knowledge bases: `keep` (the default) makes the bases global (FK set-null) and moves the library's items into the
   * global library under `files/<slug>/`; `delete` removes them. The folder on disk is NOT removed in this round
   * (a later round moves it to a trash folder).
   */
  async remove(slug: string, opts: DeleteProjectOptions = {}): Promise<{ id: string; slug: string; movedTasks: number; knowledge: { released: number; deleted: number }; resources: { moved: number; deleted: number } }> {
    const knowledgeMode = keepOrDelete(opts.knowledge, 'knowledge');
    const resourcesMode = keepOrDelete(opts.resources, 'resources');
    const cur = await this.get(slug);
    if (cur.isDefault) throw new BadRequestException('the default project cannot be deleted');
    const { active } = await this.counts(cur);
    if (active) throw new ConflictException(`project "${slug}" still has ${active} active task(s) — finish or cancel them first`);
    // the library first (files move while the row still exists), then the bases, then the row (SET NULL frees what is left)
    const resources = (await this.resources?.releaseProject(cur, resourcesMode)) ?? { moved: 0, deleted: 0 };
    const knowledge = (await this.knowledge?.releaseProject(cur.id, knowledgeMode)) ?? { released: 0, deleted: 0 };
    const moved = await this.prisma.task.updateMany({ where: { projectId: cur.id }, data: { projectId: DEFAULT_PROJECT_ID } });
    await this.prisma.project.delete({ where: { id: cur.id } });
    dropProjectLabel(cur.id);
    this.logger.log(`Deleted project "${slug}" (${moved.count} finished task(s) moved to the default project; knowledge: ${knowledgeMode}, resources: ${resourcesMode}; folder kept: ${this.dirOf(cur)})`);
    return { id: cur.id, slug: cur.slug, movedTasks: moved.count, knowledge, resources };
  }

  // ---- validation -----------------------------------------------------------------------------------------

  /** The settable fields, checked; only the ones present in `input` are returned (so an update patches). */
  private validateFields(input: ProjectInput, cur: ProjectRow | null) {
    const out: {
      repoUrl?: string | null;
      repoBranch?: string;
      repoSubdir?: string | null;
      repoAuth?: ProjectRepoAuth;
      repoPath?: string | null;
      isolation?: ProjectIsolation | null;
      verifyCommands?: string | null;
      verifyMaxAttempts?: number;
      defaultAgent?: string | null;
      pinnedAgents?: string | null;
      notifyChannelId?: string | null;
      notifyChatId?: string | null;
    } = {};
    if (input.repoUrl !== undefined) {
      const url = input.repoUrl?.trim() || null;
      if (url) {
        const parsed = parseRepoUrl(url);
        if (!parsed) throw new BadRequestException('repoUrl must be an https://, ssh:// or git@host:owner/repo.git URL');
        if (parsed.hadCredentials) throw new BadRequestException('repoUrl must not carry a token — set repoAuth and put the secret in the secrets dir');
        if (url.length > 500) throw new BadRequestException('repoUrl is too long');
      }
      out.repoUrl = url;
    }
    if (input.repoBranch !== undefined) {
      const b = normalizeBranch(input.repoBranch);
      if (!b) throw new BadRequestException('repoBranch is not a valid git branch name');
      out.repoBranch = b;
    }
    if (input.repoSubdir !== undefined) {
      const raw = (input.repoSubdir ?? '').trim();
      const sub = normalizeSubdir(raw);
      if (raw && !sub) throw new BadRequestException('repoSubdir must be a relative path inside the repository');
      out.repoSubdir = sub || null;
    }
    if (input.repoAuth !== undefined && input.repoAuth !== null) {
      if (!isRepoAuth(input.repoAuth)) throw new BadRequestException('repoAuth must be "none", "token" or "ssh"');
      out.repoAuth = input.repoAuth;
    }
    if (input.repoPath !== undefined) {
      if (cur?.isDefault) {
        if ((input.repoPath ?? null) !== cur.repoPath) throw new BadRequestException('the default project adopts WORKSPACE_REPO_PATH — its path is set by the environment');
      } else {
        const p = input.repoPath?.trim() || null;
        if (p) {
          if (!isAbsolute(p)) throw new BadRequestException('repoPath must be an absolute path');
          const abs = resolve(p);
          for (const forbidden of [this.config.secretsDir, this.config.agentDir]) {
            if (abs === resolve(forbidden) || abs.startsWith(resolve(forbidden) + sep)) throw new BadRequestException(`repoPath must not be inside ${forbidden}`);
          }
          out.repoPath = abs;
        } else out.repoPath = null;
      }
    }
    if (input.isolation !== undefined) {
      if (input.isolation !== null && !isIsolation(input.isolation)) throw new BadRequestException('isolation must be "shared", "worktree" or null (follow WORKSPACE_SHARED)');
      out.isolation = input.isolation;
    }
    if (input.verifyCommands !== undefined) {
      const v = (input.verifyCommands ?? '').replace(/\r/g, '').trim();
      if (v.length > MAX_VERIFY) throw new BadRequestException(`verifyCommands is too long (max ${MAX_VERIFY} characters)`);
      out.verifyCommands = v || null;
    }
    if (input.verifyMaxAttempts !== undefined && input.verifyMaxAttempts !== null) {
      const n = Number(input.verifyMaxAttempts);
      if (!Number.isInteger(n) || n < 0 || n > 10) throw new BadRequestException('verifyMaxAttempts must be a whole number from 0 to 10');
      out.verifyMaxAttempts = n;
    }
    if (input.defaultAgent !== undefined) out.defaultAgent = shortOrNull(input.defaultAgent, 100, 'defaultAgent');
    if (input.pinnedAgents !== undefined) {
      try {
        out.pinnedAgents = serializePinnedAgents(input.pinnedAgents);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }
    if (input.notifyChannelId !== undefined) out.notifyChannelId = shortOrNull(input.notifyChannelId, 100, 'notifyChannelId');
    if (input.notifyChatId !== undefined) out.notifyChatId = shortOrNull(input.notifyChatId, 100, 'notifyChatId');
    return out;
  }
}

function isProjectRow(v: unknown): v is ProjectRow {
  return typeof v === 'object' && v !== null && 'slug' in v && 'isDefault' in v && 'repoBranch' in v;
}

function cleanName(name: string | undefined): string | null {
  const n = (name ?? '').replace(/\s+/g, ' ').trim();
  return n && n.length <= MAX_NAME ? n : null;
}

function shortOrNull(v: string | null | undefined, max: number, field: string): string | null {
  const s = (v ?? '').trim();
  if (s.length > max) throw new BadRequestException(`${field} is too long (max ${max} characters)`);
  return s || null;
}

async function createIfMissing(path: string, content: string): Promise<void> {
  await writeFile(path, content, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e;
  });
}
