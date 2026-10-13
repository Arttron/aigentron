import { execFile } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

const pexec = promisify(execFile);
const DAY = 86_400_000;
const ACTIVE = ['queued', 'running', 'needs_approval'];
const AGENT_BRANCH = /^agent\/task-([a-z0-9]+)$/;

export interface MaintenanceReport {
  retentionDays: number;
  worktreeRetentionDays: number;
  runs: { count: number; bytes: number; stale: number; staleBytes: number };
  worktrees: { count: number; bytes: number; stale: number };
  branches: { agentBranches: number; stale: number };
  /** All task attachments, and the part that belongs to tasks finished more than 90 days ago (user files: never deleted automatically). */
  attachments: { bytes: number; oldTasksBytes: number };
  caches: CacheReport & { digestRetentionDays: number; researchRetentionDays: number };
  resources: { bytes: number };
  /** The shared workspace (memory / work / deliverables): people's and agents' results — never cleaned automatically. */
  workspace: { bytes: number };
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
  /** Also delete the `agent/task-*` branches of removed worktrees (their unpushed commits are LOST). */
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

  private get dataDir(): string {
    return dirname(this.config.agentDir);
  }

  /** `<video>.digest` folders (task attachments and library files). */
  private async digestDirs(): Promise<{ path: string; mtime: number }[]> {
    const roots: string[] = [join(this.config.agentDir, 'resources', 'files')];
    for (const t of await readdir(this.config.attachmentsDir).catch(() => [] as string[])) roots.push(join(this.config.attachmentsDir, t));
    const out: { path: string; mtime: number }[] = [];
    for (const root of roots) {
      for (const name of await readdir(root).catch(() => [] as string[])) {
        if (!name.endsWith('.digest')) continue;
        const p = join(root, name);
        const s = await stat(p).catch(() => null);
        if (s?.isDirectory()) out.push({ path: p, mtime: s.mtimeMs });
      }
    }
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

  private async git(args: string[]): Promise<string> {
    const { stdout } = await pexec('git', args, { cwd: this.config.workspaceRepoPath, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 });
    return stdout;
  }

  /** Registered worktrees under worktreesRoot, plus their task ids and whether they are stale. */
  private async worktreeState(days: number): Promise<{ path: string; id: string; stale: boolean; orphan: boolean }[]> {
    let out = '';
    try {
      out = await this.git(['worktree', 'list', '--porcelain']);
    } catch {
      return [];
    }
    const root = this.config.worktreesRoot.replace(/\/$/, '');
    const paths = out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((p) => p.startsWith(`${root}/`));
    const ids = paths.map((p) => p.slice(root.length + 1).split('/')[0]!);
    const st = await this.statuses(ids);
    const cutoff = Date.now() - days * DAY;
    const rows: { path: string; id: string; stale: boolean; orphan: boolean }[] = [];
    for (const [i, p] of paths.entries()) {
      const id = ids[i]!;
      const s = st.get(id);
      const m = await stat(p).then((x) => x.mtimeMs, () => 0);
      rows.push({ path: p, id, stale: !(s && ACTIVE.includes(s)) && m < cutoff, orphan: false });
    }
    // Directories under the worktrees root that git no longer knows about (a failed/forced removal, a reset
    // of the repo): same staleness rule, removed as plain folders.
    const known = new Set(paths);
    const dirs = await readdir(root).catch(() => [] as string[]);
    const orphanIds = dirs.filter((d) => !known.has(`${root}/${d}`));
    const ost = await this.statuses(orphanIds);
    for (const d of orphanIds) {
      const p = `${root}/${d}`;
      const m = await stat(p).then((x) => x.mtimeMs, () => 0);
      rows.push({ path: p, id: d, stale: !ACTIVE.includes(ost.get(d) ?? '') && m < cutoff, orphan: true });
    }
    return rows;
  }

  private async agentBranches(): Promise<string[]> {
    try {
      return (await this.git(['branch', '--list', 'agent/task-*', '--format=%(refname:short)'])).split('\n').map((s) => s.trim()).filter((b) => AGENT_BRANCH.test(b));
    } catch {
      return [];
    }
  }

  /** Size of the attachment folders of tasks that finished (or were deleted) more than `days` ago — user files, so only reported. */
  private async oldTaskAttachmentBytes(days: number): Promise<number> {
    const ids = await readdir(this.config.attachmentsDir).catch(() => [] as string[]);
    const st = await this.statuses(ids);
    const last = await this.lastActive(ids);
    const cutoff = Date.now() - days * DAY;
    let bytes = 0;
    for (const id of ids) {
      const s = st.get(id);
      if (s && ACTIVE.includes(s)) continue;
      if ((last.get(id) ?? 0) >= cutoff && s) continue;
      bytes += await this.dirBytes(join(this.config.attachmentsDir, id));
    }
    return bytes;
  }

  async report(): Promise<MaintenanceReport> {
    const runs = await this.runIds();
    const stale = this.retentionDays > 0 ? await this.staleRuns(this.retentionDays) : [];
    const wts = await this.worktreeState(this.worktreeRetentionDays);
    const branches = await this.agentBranches();
    const st = await this.statuses(branches.map((b) => AGENT_BRANCH.exec(b)![1]!));
    const staleBranches = branches.filter((b) => !ACTIVE.includes(st.get(AGENT_BRANCH.exec(b)![1]!) ?? ''));
    return {
      retentionDays: this.retentionDays,
      worktreeRetentionDays: this.worktreeRetentionDays,
      runs: { count: runs.length, bytes: await this.dirBytes(this.runsDir), stale: stale.length, staleBytes: stale.reduce((a, r) => a + r.bytes, 0) },
      worktrees: { count: wts.length, bytes: await this.dirBytes(this.config.worktreesRoot), stale: wts.filter((w) => w.stale).length },
      branches: { agentBranches: branches.length, stale: staleBranches.length },
      attachments: { bytes: await this.dirBytes(this.config.attachmentsDir), oldTasksBytes: await this.oldTaskAttachmentBytes(90) },
      caches: { ...(await this.cacheReport()), digestRetentionDays: this.digestRetentionDays, researchRetentionDays: this.researchRetentionDays },
      resources: { bytes: await this.dirBytes(join(this.config.agentDir, 'resources')) },
      workspace: { bytes: this.config.workspaceDir ? await this.dirBytes(this.config.workspaceDir) : 0 },
      note: 'Run folders hold per-task working files; worktrees/branches are leftovers of the old per-task worktree mode inside the project repository. Branches may contain commits that were never pushed.',
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
        else await this.git(['worktree', 'remove', '--force', w.path]).catch((e) => this.logger.warn(`could not remove worktree ${w.path}: ${(e as Error).message}`));
      }
      if (!dryRun && stale.length) await this.git(['worktree', 'prune']).catch(() => undefined);
      if (req.deleteBranches) {
        const branches = await this.agentBranches();
        const st = await this.statuses(branches.map((b) => AGENT_BRANCH.exec(b)![1]!));
        const current = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim()).catch(() => '');
        for (const b of branches) {
          const id = AGENT_BRANCH.exec(b)![1]!;
          if (ACTIVE.includes(st.get(id) ?? '') || b === current) continue;
          result.branchesDeleted += 1;
          if (!dryRun) await this.git(['branch', '-D', b]).catch((e) => this.logger.warn(`could not delete branch ${b}: ${(e as Error).message}`));
        }
      }
    }
    if (!dryRun) this.logger.log(`Cleanup done: ${result.runsRemoved} run folder(s), ${result.worktreesRemoved} worktree(s), ${result.branchesDeleted} branch(es)`);
    return result;
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
