import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { SettingsService } from '../settings/settings.service';
import { GitHubService } from '../worktrees/github.service';
import { decideCleanup, hasUncommitted, preciousIgnoredPaths, type CheckoutFacts, type CleanupDecision, type CleanupPolicy } from './finished-work';
import { MaintenanceService } from './maintenance.service';

/** One checkout and what would happen to it. */
export interface FinishedWorkItem {
  taskId: string;
  title: string;
  status: string;
  path: string;
  branch: string | null;
  base: string;
  decision: CleanupDecision;
  /** the folder's size, worked out for the ones that would be removed */
  bytes: number | null;
}

export interface FinishedWorkPlan {
  policy: CleanupPolicy;
  items: FinishedWorkItem[];
  willRemove: number;
  willFree: number;
}

export interface FinishedWorkLogEntry {
  at: string;
  taskId: string;
  title: string;
  path: string;
  reason: string;
  bytes: number;
  branchDeleted: boolean;
}

const LOG_KEEP = 300;
/** A ref name that is safe to hand to git: no leading `-` (an option), no odd characters. */
const SAFE_REF = /^[A-Za-z0-9][\w./-]*$/;
/** The first look shortly after boot, then every 6 hours (a merge is noticed within that). */
const EVERY_MS = 6 * 3_600_000;

/**
 * Clears the checkouts (git worktrees) of finished work: a task's own copy of the repository goes once its work is merged, or a few days after the task
 * is done — and only when nothing would be lost (see finished-work.ts for the rules). The task keeps working: a later message brings the checkout back
 * from its branch. Settings → Maintenance shows what would go and why, and a log of what went.
 */
@Injectable()
export class FinishedWorkService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FinishedWorkService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly maintenance: MaintenanceService,
    private readonly projects: ProjectsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    setTimeout(() => void this.sweep(), 90_000).unref();
    this.timer = setInterval(() => void this.sweep(), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private get logFile(): string {
    return join(this.config.agentDir, 'cleanup-log.jsonl');
  }

  private async git(cwd: string, args: string[]): Promise<string | null> {
    return this.maintenance.gitIn(cwd, args).then((s) => s, () => null);
  }

  /** Runs `fn` inside the task's lock (the one the worker takes when it brings a checkout back), when the worktree service is there. */
  private async locked<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    let wt: { withTaskLock: <R>(id: string, f: () => Promise<R>) => Promise<R> } | null = null;
    try {
      const { WorktreeService } = await import('../worktrees/worktree.service');
      wt = this.moduleRef.get(WorktreeService, { strict: false });
    } catch {
      wt = null; // no worktree service: no lock to take
    }
    return wt ? wt.withTaskLock(taskId, fn) : fn(); // (outside the try: a failure of `fn` must not run it a second time)
  }

  /** `git merge-base --is-ancestor a b`: true / false (exit 1) / null (could not be asked). */
  private async isAncestor(repo: string, a: string, b: string): Promise<boolean | null> {
    try {
      await this.maintenance.gitIn(repo, ['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch (e) {
      return (e as { code?: number }).code === 1 ? false : null;
    }
  }

  /**
   * What is known about one checkout, asked of git (and of GitHub for a pull request). Anything that cannot be told is `null` — never a guess.
   * The work is judged by what the FOLDER holds — its HEAD — and by the task's branch: a detached HEAD, or a branch the agent moved, must never hide commits.
   */
  private async factsOf(
    w: { path: string; repo: string },
    task: { status: string; updatedAt: Date; branch: string | null; prUrl: string | null; awaitingSubtasks: boolean; projectId: string },
    base: string,
    finishedAt: number,
  ): Promise<CheckoutFacts> {
    const status = await this.git(w.path, ['status', '--porcelain', '--untracked-files=normal', '--ignored=matching']);
    const dirty = status === null ? null : hasUncommitted(status);
    const preciousIgnored = status === null ? undefined : preciousIgnoredPaths(status).length > 0;
    const branch = task.branch && SAFE_REF.test(task.branch) ? task.branch : null;
    const headSha = ((await this.git(w.path, ['rev-parse', 'HEAD'])) ?? '').trim();
    const branchSha = branch ? ((await this.git(w.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) ?? '').trim() : '';
    // the commits to account for: where the folder is, and where the task's branch points (they differ when HEAD is detached or on another branch)
    const tips = [...new Set([headSha, branchSha].filter((x) => /^[0-9a-f]{7,64}$/i.test(x)))];
    const origin = SAFE_REF.test(base) ? await this.git(w.repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]) : null;
    const baseRef = !SAFE_REF.test(base) ? null : origin !== null ? `origin/${base}` : (await this.git(w.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`])) !== null ? base : null;
    let ahead: number | null = null;
    let pushed: boolean | null = null;
    let appliedByPatch = false;
    let unmerged: string[] = [];
    if (baseRef && tips.length && (headSha || branchSha)) {
      const counts: number[] = [];
      for (const tip of tips) {
        const n = await this.git(w.repo, ['rev-list', '--count', `${baseRef}..${tip}`]);
        const c = n === null ? NaN : Number.parseInt(n.trim(), 10);
        if (!Number.isFinite(c)) {
          counts.length = 0;
          break;
        }
        counts.push(c);
        if (c > 0) unmerged.push(tip);
      }
      ahead = counts.length === tips.length ? Math.max(0, ...counts) : null;
      if (ahead !== null && unmerged.length) {
        let allApplied = true;
        let allPushed: boolean | null = true;
        for (const tip of unmerged) {
          const cherry = await this.git(w.repo, ['cherry', baseRef, tip]);
          const lines = (cherry ?? '').split('\n').filter(Boolean);
          if (!(lines.length > 0 && lines.every((l) => l.startsWith('-')))) allApplied = false;
          const remotes = await this.git(w.repo, ['branch', '-r', '--contains', tip]);
          if (remotes === null) allPushed = null;
          else if (remotes.trim().length === 0 && allPushed !== null) allPushed = false;
        }
        appliedByPatch = allApplied;
        pushed = allPushed;
      }
      if (ahead === 0) pushed = true;
    }
    // A merged pull request covers its tip at the time of the merge; commits made after it (a later message to the task) are not in it.
    let prMerged: boolean | null = null;
    if (task.prUrl && unmerged.length && !appliedByPatch) {
      try {
        const github = this.moduleRef.get(GitHubService, { strict: false });
        const pr = await github.isPrMerged(await this.projects.contextFor({ projectId: task.projectId }), task.prUrl);
        if (pr?.merged && pr.headSha) {
          let all: boolean | null = true;
          for (const tip of unmerged) {
            const r = await this.isAncestor(w.repo, tip, pr.headSha);
            if (r === false) all = false;
            else if (r === null && all !== false) all = null;
          }
          prMerged = all;
        } else if (pr && !pr.merged) prMerged = false;
      } catch {
        prMerged = null;
      }
    }
    return { status: task.status, finishedAt, awaitingSubtasks: task.awaitingSubtasks, dirty, preciousIgnored, ahead, pushed, appliedByPatch, prMerged };
  }

  /** When each task last finished a run (its latest session end), else when its row last changed: a title or a pull-request link written later must not restart the waiting. */
  private async finishedAtOf(tasks: { id: string; updatedAt: Date }[]): Promise<Map<string, number>> {
    const out = new Map(tasks.map((t) => [t.id, t.updatedAt.getTime()]));
    try {
      const rows = await this.prisma.agentSession.groupBy({ by: ['taskId'], where: { taskId: { in: tasks.map((t) => t.id) }, endedAt: { not: null } }, _max: { endedAt: true } });
      for (const r of rows) if (r._max.endedAt) out.set(r.taskId, r._max.endedAt.getTime());
    } catch {
      /* the row's own time is used */
    }
    return out;
  }

  /** Every checkout under the worktrees root, with the decision the current policy makes about it. Touches nothing. */
  async plan(): Promise<FinishedWorkPlan> {
    const policy = await this.settings.cleanupPolicy();
    const wts = (await this.maintenance.listWorktrees()).filter((w) => !w.orphan);
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: wts.map((w) => w.id) } },
      select: { id: true, title: true, status: true, updatedAt: true, branch: true, prUrl: true, awaitingSubtasks: true, projectId: true },
    });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const finished = await this.finishedAtOf(tasks);
    const projects = await this.prisma.project.findMany({ select: { id: true, repoBranch: true } });
    const baseOf = new Map(projects.map((p) => [p.id, p.repoBranch || 'main']));
    const items: FinishedWorkItem[] = [];
    for (const w of wts) {
      const t = byId.get(w.id);
      if (!t) continue; // the task is gone: the age rule of the general cleanup handles what it left
      const base = baseOf.get(t.projectId) ?? 'main';
      const facts = await this.factsOf(w, t, base, finished.get(t.id) ?? t.updatedAt.getTime());
      const decision = decideCleanup(policy, facts);
      items.push({ taskId: t.id, title: t.title, status: t.status, path: w.path, branch: t.branch, base, decision, bytes: decision.remove ? await this.maintenance.bytesOf(w.path) : null });
    }
    items.sort((a, b) => Number(b.decision.remove) - Number(a.decision.remove) || (b.bytes ?? 0) - (a.bytes ?? 0));
    return { policy, items, willRemove: items.filter((i) => i.decision.remove).length, willFree: items.reduce((n, i) => n + (i.decision.remove ? (i.bytes ?? 0) : 0), 0) };
  }

  /** Clear what the policy allows. Each checkout is asked about again right before it goes (a person may have started working in it since the plan). */
  async sweep(): Promise<{ removed: number; freed: number; entries: FinishedWorkLogEntry[] }> {
    const none = { removed: 0, freed: 0, entries: [] as FinishedWorkLogEntry[] };
    if (this.running) return none;
    this.running = true;
    try {
      const plan = await this.plan();
      if (plan.policy.mode === 'off') return none;
      const entries: FinishedWorkLogEntry[] = [];
      const repos = new Set<string>();
      for (const item of plan.items.filter((i) => i.decision.remove)) {
        // The state is read and the folder removed INSIDE the task's lock: a message that starts the task meanwhile either has already marked it
        // running (seen here: the folder stays) or waits for the lock and finds the checkout cleared (it is then restored before the agent starts).
        const entry = await this.locked(item.taskId, async () => {
          const w = (await this.maintenance.listWorktrees()).find((x) => x.path === item.path);
          const t = w && (await this.prisma.task.findUnique({ where: { id: item.taskId }, select: { id: true, title: true, status: true, updatedAt: true, branch: true, prUrl: true, awaitingSubtasks: true, projectId: true } }));
          if (!w || !t) return null;
          const finishedAt = (await this.finishedAtOf([t])).get(t.id) ?? t.updatedAt.getTime();
          const now = decideCleanup(plan.policy, await this.factsOf(w, t, item.base, finishedAt));
          if (!now.remove) return null;
          try {
            // a running preview of the checkout is stopped first
            try {
              const { PreviewService } = await import('../preview/preview.service');
              this.moduleRef.get(PreviewService, { strict: false })?.stop(item.taskId);
            } catch {
              /* no preview service */
            }
            await this.maintenance.gitIn(w.repo, ['worktree', 'remove', '--force', w.path]);
            repos.add(w.repo);
            let branchDeleted = false;
            // only the agent's own branches, and only when their work is in the base branch (nothing is lost)
            if (now.deleteBranch && item.branch && item.branch.startsWith('agent/') && SAFE_REF.test(item.branch)) {
              branchDeleted = (await this.git(w.repo, ['branch', '-D', item.branch])) !== null;
            }
            return { at: new Date().toISOString(), taskId: item.taskId, title: item.title, path: w.path, reason: now.reason, bytes: item.bytes ?? 0, branchDeleted } as FinishedWorkLogEntry;
          } catch (e) {
            this.logger.warn(`Could not clear the checkout of task ${item.taskId}: ${(e as Error).message}`);
            return null;
          }
        });
        if (entry) entries.push(entry);
      }
      for (const repo of repos) await this.git(repo, ['worktree', 'prune']);
      if (entries.length) {
        await this.appendLog(entries);
        const freed = entries.reduce((n, e) => n + e.bytes, 0);
        this.logger.log(`Cleared ${entries.length} checkout(s) of finished work, ${(freed / 1024 / 1024).toFixed(0)} MB freed`);
        return { removed: entries.length, freed, entries };
      }
      return none;
    } catch (e) {
      this.logger.warn(`Clearing finished work failed: ${(e as Error).message}`);
      return none;
    } finally {
      this.running = false;
    }
  }

  private async appendLog(entries: FinishedWorkLogEntry[]): Promise<void> {
    try {
      await mkdir(this.config.agentDir, { recursive: true });
      await appendFile(this.logFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
      // bounded: the last LOG_KEEP lines
      const lines = (await readFile(this.logFile, 'utf8')).split('\n').filter(Boolean);
      if (lines.length > LOG_KEEP * 2) await writeFile(this.logFile, lines.slice(-LOG_KEEP).join('\n') + '\n');
    } catch (e) {
      this.logger.warn(`Could not write the cleanup log: ${(e as Error).message}`);
    }
  }

  /** What was cleared lately, newest first. */
  async log(limit = 50): Promise<FinishedWorkLogEntry[]> {
    try {
      const lines = (await readFile(this.logFile, 'utf8')).split('\n').filter(Boolean);
      return lines.slice(-limit).reverse().flatMap((l) => {
        try {
          return [JSON.parse(l) as FinishedWorkLogEntry];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }
}
