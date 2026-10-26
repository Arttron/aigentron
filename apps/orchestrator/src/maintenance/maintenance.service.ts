import { execFile } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';

const pexec = promisify(execFile);
const DAY = 86_400_000;
/** A digest folder younger than this is left alone by pruning (it may be mid-build or just read). */
const DIGEST_IN_USE_MS = 10 * 60_000;
const ACTIVE = ['queued', 'running', 'needs_approval'];
const AGENT_BRANCH = /^agent\/task-([a-z0-9]+)$/;

/** One project's footprint on disk. */
export interface ProjectDiskReport {
  slug: string;
  name: string;
  isDefault: boolean;
  archived: boolean;
  /** The project folder (memory / work / deliverables — the default project's is the shared workspace). */
  dir: string;
  bytes: number;
  /** The checkout, when it lives outside the folder (the default project's WORKSPACE_REPO_PATH); 0 when it is inside `dir` (already counted). */
  repoPath: string;
  repoBytes: number;
}

export interface MaintenanceReport {
  retentionDays: number;
  worktreeRetentionDays: number;
  runs: { count: number; bytes: number; stale: number; staleBytes: number };
  worktrees: { count: number; bytes: number; stale: number };
  branches: { agentBranches: number; stale: number };
  /** All task attachments, and the part that belongs to tasks finished more than 90 days ago (user files: deleted only when `retentionDays` > 0 — off by default). */
  attachments: { bytes: number; oldTasksBytes: number; retentionDays: number };
  caches: CacheReport & { digestRetentionDays: number; researchRetentionDays: number };
  resources: { bytes: number };
  /** The shared workspace (memory / work / deliverables): people's and agents' results — never cleaned automatically. */
  workspace: { bytes: number };
  /** Every project's folder and checkout (the default project's folder IS the shared workspace above) — never cleaned automatically. */
  projects: ProjectDiskReport[];
  note: string;
}

/** What the caches hold (all of it is regenerated on demand, so it is safe to prune). */
export interface CacheReport {
  digests: { count: number; bytes: number; stale: number; staleBytes: number };
  research: { count: number; bytes: number; stale: number; staleBytes: number };
}

export interface CleanupRequest {
  /** Defaults to true: report what would be removed without touching anything. */
  dryRun?: boolean;
  runs?: boolean;
  worktrees?: boolean;
  /** Also delete the `agent/*` task branches of removed worktrees (their unpushed commits are LOST). */
  deleteBranches?: boolean;
  olderThanDays?: number;
}

export interface CleanupResult {
  dryRun: boolean;
  runsRemoved: number;
  runBytes: number;
  worktreesRemoved: number;
  branchesDeleted: number;
}

/**
 * Housekeeping for what runs leave behind: per-task run folders (`<agentDir>/runs/<taskId>`) and, from the old
 * worktree mode, per-task git worktrees + `agent/task-*` branches inside the PROJECT repo.
 *
 *  - run folders: scheduled daily, older than RUNS_RETENTION_DAYS (default 14; 0 disables), never for live tasks;
 *  - worktrees/branches: only on explicit request (or CLEANUP_WORKTREES=true), older than WORKTREE_RETENTION_DAYS
 *    (default 30), only for finished/deleted tasks. Branches are kept unless deleteBranches is set — their commits
 *    may never have been pushed.
 * Credentials never linger in run folders: every boot scrubs any leftover `auth.json`.
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  private num(name: string, def: number): number {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== '' ? v : def;
  }
  get retentionDays(): number {
    return this.num('RUNS_RETENTION_DAYS', 14);
  }
  get worktreeRetentionDays(): number {
    return this.num('WORKTREE_RETENTION_DAYS', 30);
  }
  /** Frames + transcript cached next to a video (regenerated when the video is used again, which costs a little speech recognition). */
  get digestRetentionDays(): number {
    return this.num('DIGEST_RETENTION_DAYS', 30);
  }
  /** Web pages the research tools fetched (kept so quotes can be verified; old ones are re-fetched when needed). */
  get researchRetentionDays(): number {
    return this.num('RESEARCH_CACHE_RETENTION_DAYS', 180);
  }
  /** Attachments of FINISHED tasks older than this are removed (the person's own files — so off by default: 0 = never). */
  get attachmentsRetentionDays(): number {
    return Math.max(0, this.num('ATTACHMENTS_RETENTION_DAYS', 0));
  }

  private get dataDir(): string {
    return dirname(this.config.agentDir);
  }

  /** Where video digests live: `<agentDir>/cache/digests/<hash>`. */
  private get digestsDir(): string {
    return join(this.config.agentDir, 'cache', 'digests');
  }

  /**
   * Video digest folders: the cache folder, plus any `<video>.digest` left next to a video by versions before 0.1.63 (attachments,
   * library files, the workspace) — those are pruned like the rest and moved into the cache the next time the video is used.
   */
  private async digestDirs(): Promise<{ path: string; mtime: number }[]> {
    const out: { path: string; mtime: number }[] = [];
    const add = async (p: string) => {
      const s = await stat(p).catch(() => null);
      if (s?.isDirectory()) out.push({ path: p, mtime: s.mtimeMs });
    };
    for (const name of await readdir(this.digestsDir).catch(() => [] as string[])) await add(join(this.digestsDir, name));
    const legacyRoots: string[] = [join(this.config.agentDir, 'resources', 'files')];
    for (const t of await readdir(this.config.attachmentsDir).catch(() => [] as string[])) legacyRoots.push(join(this.config.attachmentsDir, t));
    for (const root of legacyRoots) for (const name of await readdir(root).catch(() => [] as string[])) if (name.endsWith('.digest')) await add(join(root, name));
    if (this.config.workspaceDir) for (const p of await findLegacyDigests(this.config.workspaceDir, 6)) await add(p);
    return out;
  }

  private async researchFiles(): Promise<{ path: string; mtime: number; bytes: number }[]> {
    const dir = join(this.config.agentDir, 'research-cache');
    const out: { path: string; mtime: number; bytes: number }[] = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const s = await stat(join(dir, name)).catch(() => null);
      if (s?.isFile()) out.push({ path: join(dir, name), mtime: s.mtimeMs, bytes: s.size });
    }
    return out;
  }

  async cacheReport(): Promise<CacheReport> {
    const dCut = Date.now() - this.digestRetentionDays * DAY;
    const rCut = Date.now() - this.researchRetentionDays * DAY;
    const digests = await this.digestDirs();
    const sized = await Promise.all(digests.map(async (d) => ({ ...d, bytes: await this.dirBytes(d.path) })));
    const research = await this.researchFiles();
    const dStale = this.digestRetentionDays > 0 ? sized.filter((d) => d.mtime < dCut) : [];
    const rStale = this.researchRetentionDays > 0 ? research.filter((r) => r.mtime < rCut) : [];
    return {
      digests: { count: sized.length, bytes: sized.reduce((a, d) => a + d.bytes, 0), stale: dStale.length, staleBytes: dStale.reduce((a, d) => a + d.bytes, 0) },
      research: { count: research.length, bytes: research.reduce((a, r) => a + r.bytes, 0), stale: rStale.length, staleBytes: rStale.reduce((a, r) => a + r.bytes, 0) },
    };
  }

  /** Remove cached digests / fetched pages older than the given days (0 = all digests). Regenerable data only. */
  async pruneCaches(o: { digestDays?: number; researchDays?: number } = {}): Promise<{ digests: number; research: number; bytes: number }> {
    const dDays = o.digestDays ?? this.digestRetentionDays;
    const rDays = o.researchDays ?? this.researchRetentionDays;
    let bytes = 0;
    let digests = 0;
    let research = 0;
    if (dDays >= 0 && (o.digestDays !== undefined || this.digestRetentionDays > 0)) {
      const cut = Date.now() - dDays * DAY;
      for (const d of await this.digestDirs()) {
        if (d.mtime >= cut && dDays > 0) continue;
        if (Date.now() - d.mtime < DIGEST_IN_USE_MS) continue; // built or touched a moment ago: may be in use, even for the emergency relief
        bytes += await this.dirBytes(d.path);
        await rm(d.path, { recursive: true, force: true }).catch(() => undefined);
        digests += 1;
      }
    }
    if (rDays > 0) {
      const cut = Date.now() - rDays * DAY;
      for (const r of await this.researchFiles()) {
        if (r.mtime >= cut) continue;
        bytes += r.bytes;
        await rm(r.path, { force: true }).catch(() => undefined);
        research += 1;
      }
    }
    return { digests, research, bytes };
  }

  /** The emergency button (also used automatically when the disk is critically full): all digests, pages older than 30 days, run folders older than 3 days. */
  async relieve(): Promise<{ digests: number; research: number; runs: number; bytes: number }> {
    const c = await this.pruneCaches({ digestDays: 0, researchDays: 30 });
    const r = await this.cleanup({ dryRun: false, runs: true, worktrees: false, olderThanDays: 3 });
    this.logger.warn(`Space relief: ${c.digests} digest cache(s), ${c.research} cached page(s), ${r.runsRemoved} run folder(s) — ${mb(c.bytes + r.runBytes)}`);
    return { digests: c.digests, research: c.research, runs: r.runsRemoved, bytes: c.bytes + r.runBytes };
  }

  private get runsDir(): string {
    return join(this.config.agentDir, 'runs');
  }

  onApplicationBootstrap(): void {
    void this.scrubCredentials().catch((e) => this.logger.warn(`credential scrub failed: ${(e as Error).message}`));
    // First pass shortly after boot, then every 6 hours.
    setTimeout(() => void this.scheduled(), 60_000).unref();
    this.timer = setInterval(() => void this.scheduled(), 6 * 3_600_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async scheduled(): Promise<void> {
    try {
      const worktrees = /^(1|true|yes)$/i.test(process.env.CLEANUP_WORKTREES ?? '');
      const res = await this.cleanup({ dryRun: false, runs: this.retentionDays > 0, worktrees, deleteBranches: false });
      const caches = await this.pruneCaches();
      if (caches.digests || caches.research) this.logger.log(`Scheduled cache pruning: ${caches.digests} digest cache(s), ${caches.research} cached page(s) (${mb(caches.bytes)})`);
      await this.pruneAttachments();
      if (res.runsRemoved || res.worktreesRemoved) {
        this.logger.log(`Scheduled cleanup: ${res.runsRemoved} run folder(s) (${mb(res.runBytes)}), ${res.worktreesRemoved} worktree(s)`);
      }
    } catch (e) {
      this.logger.warn(`scheduled cleanup failed: ${(e as Error).message}`);
    }
  }

  /** Remove any credential file a past run left in its folder. */
  private async scrubCredentials(): Promise<void> {
    for (const id of await this.runIds()) {
      await rm(join(this.runsDir, id, 'codex-home', 'auth.json'), { force: true }).catch(() => undefined);
    }
  }

  private async runIds(): Promise<string[]> {
    return readdir(this.runsDir).catch(() => []);
  }

  private async dirBytes(path: string): Promise<number> {
    try {
      const { stdout } = await pexec('du', ['-sk', path], { timeout: 60_000 });
      return Number(stdout.split(/\s/)[0]) * 1024 || 0;
    } catch {
      return 0;
    }
  }

  /** taskId -> status for the given ids; ids not in the DB are absent from the map. */
  private async statuses(ids: string[]): Promise<Map<string, string>> {
    const rows = ids.length ? await this.prisma.task.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }) : [];
    return new Map(rows.map((r) => [r.id, r.status as string]));
  }

  /** taskId -> last activity (ms): resumable tasks (e.g. a long-lived admin chat) must not lose their run folder while in use. */
  private async lastActive(ids: string[]): Promise<Map<string, number>> {
    const rows = ids.length ? await this.prisma.task.findMany({ where: { id: { in: ids } }, select: { id: true, updatedAt: true } }) : [];
    return new Map(rows.map((r) => [r.id, r.updatedAt.getTime()]));
  }

  private async staleRuns(days: number): Promise<{ id: string; bytes: number }[]> {
    const ids = await this.runIds();
    const st = await this.statuses(ids);
    const active = await this.lastActive(ids);
    const cutoff = Date.now() - days * DAY;
    const out: { id: string; bytes: number }[] = [];
    for (const id of ids) {
      const s = st.get(id);
      if (s && ACTIVE.includes(s)) continue; // a live task keeps its folder
      const dirM = await stat(join(this.runsDir, id)).then((x) => x.mtimeMs, () => Date.now());
      const m = Math.max(dirM, active.get(id) ?? 0);
      if (m < cutoff) out.push({ id, bytes: await this.dirBytes(join(this.runsDir, id)) });
    }
    return out;
  }

  private async git(repo: string, args: string[]): Promise<string> {
    const { stdout } = await pexec('git', args, { cwd: repo, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 });
    return stdout;
  }

  /** The checkouts of every project (the default first; archived ones too — their worktrees and branches are leftovers like any other). */
  private async repos(): Promise<string[]> {
    const rows = await this.projects.list({ includeArchived: true }).catch(() => []);
    const paths = rows.map((r) => this.projects.repoPathOf(r));
    if (!paths.length) paths.push(this.config.workspaceRepoPath);
    return [...new Set(paths)];
  }

  /**
   * Registered worktrees under worktreesRoot (of every project's checkout), plus their task ids and whether they are stale.
   * Both layouts are understood: `<root>/<taskId>` (before projects) and `<root>/<slug>/<taskId>`.
   */
  private async worktreeState(days: number): Promise<{ path: string; id: string; repo: string; stale: boolean; orphan: boolean }[]> {
    const root = this.config.worktreesRoot.replace(/\/$/, '');
    const known: { path: string; repo: string }[] = [];
    for (const repo of await this.repos()) {
      const out = await this.git(repo, ['worktree', 'list', '--porcelain']).catch(() => '');
      for (const p of out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((p) => p.startsWith(`${root}/`))) known.push({ path: p, repo });
    }
    const idOf = (p: string) => p.slice(root.length + 1).split('/').filter(Boolean).pop()!;
    const st = await this.statuses(known.map((k) => idOf(k.path)));
    const cutoff = Date.now() - days * DAY;
    const rows: { path: string; id: string; repo: string; stale: boolean; orphan: boolean }[] = [];
    for (const k of known) {
      const id = idOf(k.path);
      const s = st.get(id);
      const m = await stat(k.path).then((x) => x.mtimeMs, () => 0);
      rows.push({ path: k.path, id, repo: k.repo, stale: !(s && ACTIVE.includes(s)) && m < cutoff, orphan: false });
    }
    // Directories under the worktrees root that no checkout knows about (a failed/forced removal, a reset of the
    // repo, a deleted project): same staleness rule, removed as plain folders. A checkout has `.git` inside; an
    // entry without one is a project's container of nested worktrees.
    const knownPaths = new Set(known.map((k) => k.path));
    const candidates: string[] = [];
    for (const d of await readdir(root).catch(() => [] as string[])) {
      const p = `${root}/${d}`;
      if ((await stat(p).catch(() => null))?.isDirectory() !== true) continue;
      if (await stat(join(p, '.git')).then(() => true, () => false)) candidates.push(p);
      else for (const c of await readdir(p).catch(() => [] as string[])) if ((await stat(`${p}/${c}`).catch(() => null))?.isDirectory()) candidates.push(`${p}/${c}`);
    }
    const orphans = candidates.filter((p) => !knownPaths.has(p));
    const ost = await this.statuses(orphans.map(idOf));
    for (const p of orphans) {
      const id = idOf(p);
      const m = await stat(p).then((x) => x.mtimeMs, () => 0);
      rows.push({ path: p, id, repo: '', stale: !ACTIVE.includes(ost.get(id) ?? '') && m < cutoff, orphan: true });
    }
    return rows;
  }

  /**
   * The agents' task branches of every project's checkout — the old `agent/task-<id>` and the readable `agent/<title>-<id6>` ones — each with the id of
   * the task it belongs to. A readable branch is matched through the task's stored branch; one no task owns is not listed (never counted, never deleted).
   */
  private async agentBranches(): Promise<{ repo: string; branch: string; taskId: string }[]> {
    const found: { repo: string; branch: string }[] = [];
    for (const repo of await this.repos()) {
      const list = await this.git(repo, ['branch', '--list', 'agent/*', '--format=%(refname:short)']).catch(() => '');
      for (const b of list.split('\n').map((s) => s.trim()).filter(Boolean)) found.push({ repo, branch: b });
    }
    const named = found.filter((b) => !AGENT_BRANCH.test(b.branch)).map((b) => b.branch);
    const rows = named.length ? await this.prisma.task.findMany({ where: { branch: { in: named } }, select: { id: true, branch: true } }) : [];
    const byBranch = new Map(rows.map((r) => [r.branch as string, r.id]));
    const out: { repo: string; branch: string; taskId: string }[] = [];
    for (const b of found) {
      const taskId = AGENT_BRANCH.exec(b.branch)?.[1] ?? byBranch.get(b.branch);
      if (taskId) out.push({ ...b, taskId });
    }
    return out;
  }

  /** Each project's folder and checkout on disk (people's and agents' results: reported, never cleaned). */
  private async projectReports(): Promise<ProjectDiskReport[]> {
    const rows = await this.projects.list({ includeArchived: true }).catch(() => []);
    const out: ProjectDiskReport[] = [];
    for (const r of rows) {
      const dir = this.projects.dirOf(r);
      const repoPath = this.projects.repoPathOf(r);
      const inside = repoPath === dir || repoPath.startsWith(`${dir}/`);
      out.push({
        slug: r.slug,
        name: r.name,
        isDefault: r.isDefault,
        archived: Boolean(r.archivedAt),
        dir,
        bytes: await this.dirBytes(dir),
        repoPath,
        repoBytes: inside ? 0 : await this.dirBytes(repoPath),
      });
    }
    return out;
  }

  /**
   * Attachment folders of tasks that finished (or were deleted) more than `days` ago. A live task is never listed; a task still in the
   * database counts by its last activity, a folder of a deleted task by its own modification time.
   */
  private async oldTaskAttachments(days: number): Promise<{ id: string; path: string }[]> {
    const ids = (await readdir(this.config.attachmentsDir).catch(() => [] as string[])).filter((id) => /^[\w-]+$/.test(id));
    const st = await this.statuses(ids);
    const last = await this.lastActive(ids);
    const cutoff = Date.now() - days * DAY;
    const out: { id: string; path: string }[] = [];
    for (const id of ids) {
      const s = st.get(id);
      if (s && ACTIVE.includes(s)) continue;
      const path = join(this.config.attachmentsDir, id);
      const when = s ? (last.get(id) ?? 0) : await stat(path).then((x) => x.mtimeMs, () => 0);
      if (when < cutoff) out.push({ id, path });
    }
    return out;
  }

  /** Size of the attachment folders of tasks that finished (or were deleted) more than `days` ago — for the report. */
  private async oldTaskAttachmentBytes(days: number): Promise<number> {
    let bytes = 0;
    for (const a of await this.oldTaskAttachments(days)) bytes += await this.dirBytes(a.path);
    return bytes;
  }

  /**
   * Remove the attachments of tasks finished more than `days` ago (files AND links; the linked workspace/library files stay). Only when
   * the person switched it on (`ATTACHMENTS_RETENTION_DAYS` > 0); a live task, or a task active within the period, is never touched.
   */
  async pruneAttachments(days = this.attachmentsRetentionDays): Promise<{ removed: number; bytes: number }> {
    let removed = 0;
    let bytes = 0;
    if (!(days > 0)) return { removed, bytes };
    for (const a of await this.oldTaskAttachments(days)) {
      bytes += await this.dirBytes(a.path);
      await rm(a.path, { recursive: true, force: true }).catch(() => undefined);
      removed += 1;
    }
    if (removed) this.logger.log(`Removed the attachments of ${removed} task(s) finished over ${days} days ago (${mb(bytes)})`);
    return { removed, bytes };
  }

  async report(): Promise<MaintenanceReport> {
    const runs = await this.runIds();
    const stale = this.retentionDays > 0 ? await this.staleRuns(this.retentionDays) : [];
    const wts = await this.worktreeState(this.worktreeRetentionDays);
    const branches = await this.agentBranches();
    const st = await this.statuses(branches.map((b) => b.taskId));
    const staleBranches = branches.filter((b) => !ACTIVE.includes(st.get(b.taskId) ?? ''));
    return {
      retentionDays: this.retentionDays,
      worktreeRetentionDays: this.worktreeRetentionDays,
      runs: { count: runs.length, bytes: await this.dirBytes(this.runsDir), stale: stale.length, staleBytes: stale.reduce((a, r) => a + r.bytes, 0) },
      worktrees: { count: wts.length, bytes: await this.dirBytes(this.config.worktreesRoot), stale: wts.filter((w) => w.stale).length },
      branches: { agentBranches: branches.length, stale: staleBranches.length },
      attachments: { bytes: await this.dirBytes(this.config.attachmentsDir), oldTasksBytes: await this.oldTaskAttachmentBytes(90), retentionDays: this.attachmentsRetentionDays },
      caches: { ...(await this.cacheReport()), digestRetentionDays: this.digestRetentionDays, researchRetentionDays: this.researchRetentionDays },
      resources: { bytes: await this.dirBytes(join(this.config.agentDir, 'resources')) },
      workspace: { bytes: this.config.workspaceDir ? await this.dirBytes(this.config.workspaceDir) : 0 },
      projects: await this.projectReports(),
      note: 'Run folders hold per-task working files; worktrees/branches are leftovers of the per-task worktree mode inside a project checkout. Branches may contain commits that were never pushed. Project folders and checkouts are never cleaned automatically.',
    };
  }

  async cleanup(req: CleanupRequest = {}): Promise<CleanupResult> {
    const dryRun = req.dryRun !== false;
    // Same bounds as the admin tool: 0/negative/NaN must never turn "older than N days" into "everything".
    if (req.olderThanDays !== undefined && !(Number.isFinite(req.olderThanDays) && req.olderThanDays >= 1)) req = { ...req, olderThanDays: undefined };
    const result: CleanupResult = { dryRun, runsRemoved: 0, runBytes: 0, worktreesRemoved: 0, branchesDeleted: 0 };

    if (req.runs !== false) {
      const days = req.olderThanDays ?? this.retentionDays;
      if (days > 0) {
        for (const r of await this.staleRuns(days)) {
          result.runsRemoved += 1;
          result.runBytes += r.bytes;
          if (!dryRun) await rm(join(this.runsDir, r.id), { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }

    if (req.worktrees) {
      const days = req.olderThanDays ?? this.worktreeRetentionDays;
      const stale = (await this.worktreeState(days)).filter((w) => w.stale);
      for (const w of stale) {
        result.worktreesRemoved += 1;
        if (dryRun) continue;
        if (w.orphan) await rm(w.path, { recursive: true, force: true }).catch((e) => this.logger.warn(`could not remove ${w.path}: ${(e as Error).message}`));
        else await this.git(w.repo, ['worktree', 'remove', '--force', w.path]).catch((e) => this.logger.warn(`could not remove worktree ${w.path}: ${(e as Error).message}`));
      }
      if (!dryRun && stale.length) for (const repo of new Set(stale.map((w) => w.repo).filter(Boolean))) await this.git(repo, ['worktree', 'prune']).catch(() => undefined);
      if (req.deleteBranches) {
        const branches = await this.agentBranches();
        const st = await this.statuses(branches.map((b) => b.taskId));
        const current = new Map<string, string>();
        for (const repo of new Set(branches.map((b) => b.repo))) current.set(repo, await this.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim()).catch(() => ''));
        for (const b of branches) {
          const id = b.taskId;
          if (ACTIVE.includes(st.get(id) ?? '') || b.branch === current.get(b.repo)) continue;
          result.branchesDeleted += 1;
          if (!dryRun) await this.git(b.repo, ['branch', '-D', b.branch]).catch((e) => this.logger.warn(`could not delete branch ${b.branch}: ${(e as Error).message}`));
        }
      }
    }
    if (!dryRun) this.logger.log(`Cleanup done: ${result.runsRemoved} run folder(s), ${result.worktreesRemoved} worktree(s), ${result.branchesDeleted} branch(es)`);
    return result;
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

/** `*.digest` folders left under a tree by versions before 0.1.63 (bounded depth; hidden folders and node_modules skipped). */
async function findLegacyDigests(dir: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.name.endsWith('.digest')) out.push(p);
    else if (depth > 0) out.push(...(await findLegacyDigests(p, depth - 1)));
  }
  return out;
}
