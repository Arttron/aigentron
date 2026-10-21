import { mkdir } from 'node:fs/promises';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { isTerminalStatus } from '@lds/shared';
import { AppConfigService } from '../config/app-config.service';
import { TasksService } from '../tasks/tasks.service';
import { WorktreeService } from '../worktrees/worktree.service';
import { GitHubService } from '../worktrees/github.service';
import { AgentExecutor } from '../agent/agent-executor';
import { SettingsService } from '../settings/settings.service';
import { PreviewService } from '../preview/preview.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AgentRegistryService } from '../agent-registry/agent-registry.service';
import { ProjectsService } from '../projects/projects.service';
import { docsWorkDirOf, resolveWorkDir, type ProjectContext } from '../projects/project-context';
import { KeyedMutex } from '../projects/project-mutex';
import { StartThrottle, waitForCapacity } from './capacity-gate';
import { clearHold, setHold } from './holds';
import { QUEUED_STALL_MESSAGE, QUEUED_SWEEP_AFTER_MS, QUEUED_SWEEP_EVERY_MS, queuedFate } from './queued-reconcile';
import { VerificationService, type VerifyResult } from './verification.service';
import { TaskQueue, type TaskJobData } from './queue.constants';
import { decideStatus } from './decide-status';

/** How often to check Settings for a changed concurrency value. Not event-driven
 *  (the setting can change from a plain PUT /settings with no signal to this
 *  service) — a short poll is simpler than wiring a notify path for a value
 *  that changes rarely and isn't latency-sensitive. */
const CONCURRENCY_SYNC_MS = 10_000;

/**
 * Consumer side of the task queue. For each job it drives the task lifecycle:
 *   queued -> running -> (worktree) -> executor -> done | failed
 * and supervises the agent run via the injected AgentExecutor.
 *
 * Projects (docs/plan-projects-workspace.md §2.6): every job first resolves its task's project. A shared-mode
 * project is a FIFO lock — its tasks take turns in the one checkout — while tasks of different projects run side
 * by side under the global concurrency cap. A task waiting for its project's lock hands its slot to the others
 * (the worker's effective concurrency is raised by one per waiter and restored once it has the lock), so a busy
 * project never starves the rest. A lead never holds the lock while it waits for subtasks: its run has returned
 * by then, and the lock goes with the job.
 */
@Injectable()
export class TaskWorkerService implements OnModuleInit {
  private readonly logger = new Logger(TaskWorkerService.name);
  /** Tasks already handed back to the lead once for decomposition (one-shot). */
  private readonly decomposeHandedBack = new Set<string>();
  /** The per-project lock of shared mode. */
  private readonly projectLocks = new KeyedMutex();
  /** Jobs currently waiting for a project lock (each one lends its slot to the rest). */
  private waiting = 0;
  private lastConcurrency = 0;
  /** the last time a start was held back by the machine's load (for the admin's metrics) */
  /** Run starts go through one at a time, spread out (a burst of held runs must not all start in the same second). */
  private readonly starts = new StartThrottle();
  capacityHeld: { at: number; waitedMs: number; forced: boolean } | null = null;

  constructor(
    private readonly queue: TaskQueue,
    private readonly config: AppConfigService,
    private readonly tasks: TasksService,
    private readonly worktrees: WorktreeService,
    private readonly github: GitHubService,
    private readonly executor: AgentExecutor,
    private readonly settings: SettingsService,
    private readonly verification: VerificationService,
    private readonly preview: PreviewService,
    private readonly approvals: ApprovalsService,
    private readonly agents: AgentRegistryService,
    private readonly projects: ProjectsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // A fresh process has nothing running — clear orphaned `running` rows left
    // by a previous (crashed) process BEFORE the worker starts, so a resumed
    // job can't be flipped back to `stalled` by the reconcile mid-run.
    await this.tasks.reconcileOrphanedRunning().catch((err) => {
      this.logger.warn(`Orphan reconciliation failed: ${(err as Error).message}`);
    });
    // Settings.concurrency seeds from AppConfigService.agentConcurrency on its
    // own first load (see SettingsService), so this already reflects the
    // env/shared-workspace default the very first time — no special-casing
    // needed here for "not set yet".
    this.lastConcurrency = await this.settings.concurrency();
    await this.queue.startWorker((data) => this.process(data), this.lastConcurrency);
    setInterval(() => void this.syncConcurrency(), CONCURRENCY_SYNC_MS);
    // Tasks left `queued` by a previous process whose job is gone would wait forever: run them again, or stall them (resumable) — at boot
    // (what is claimed belongs to a dead process) and then every few minutes for jobs that vanished while the server kept running.
    void this.reconcileQueued(0, false);
    const sweep = setInterval(() => void this.reconcileQueued(QUEUED_SWEEP_AFTER_MS, true), QUEUED_SWEEP_EVERY_MS);
    sweep.unref?.();
  }

  /** Look for `queued` tasks (older than `minAgeMs`) that have no job in the queue and give each its fate (queuedFate). Never throws. */
  async reconcileQueued(minAgeMs: number, includeActive: boolean): Promise<{ requeued: number; stalled: number }> {
    let requeued = 0;
    let stalled = 0;
    try {
      for (const t of await this.tasks.queuedTasksBefore(new Date(Date.now() - minAgeMs))) {
        const fate = queuedFate({ hasJob: await this.queue.hasJobFor(t.id, { includeActive }), sessions: t.sessions });
        if (fate === 'keep') continue;
        if (fate === 'requeue') {
          await this.tasks.requeue(t.id, t.agentName);
          requeued++;
          this.logger.warn(`Task ${t.id} was queued but had no job in the queue — queued again`);
        } else {
          await this.tasks.setStatus(t.id, 'stalled', QUEUED_STALL_MESSAGE);
          stalled++;
          // A lead that was waiting for its subtasks while it sat `queued` was never woken (its subtasks finished meanwhile): do it now.
          await this.tasks.wakeIfSubtasksDone(t.id).catch((err) => this.logger.warn(`Could not resume lead ${t.id}: ${(err as Error).message}`));
          this.logger.warn(`Task ${t.id} was queued but had no job in the queue — marked stalled (send it again or press Continue)`);
        }
      }
    } catch (err) {
      this.logger.warn(`Queue reconcile failed: ${(err as Error).message}`);
    }
    return { requeued, stalled };
  }

  /** Poll Settings for a changed concurrency and push it into the running
   *  worker live — see TaskQueue.setConcurrency's doc for why this is a poll. */
  private async syncConcurrency(): Promise<void> {
    const n = await this.settings.concurrency().catch(() => this.lastConcurrency);
    if (n === this.lastConcurrency) return;
    this.lastConcurrency = n;
    this.applyConcurrency();
    this.logger.log(`Concurrency updated to ${n}`);
  }

  /** The cap the queue runs with right now: the configured value plus one slot per job waiting for a project lock. */
  private applyConcurrency(): void {
    this.queue.setConcurrency(this.lastConcurrency + this.waiting);
  }

  /**
   * Take the project's lock when its mode calls for one (shared mode: one task at a time in the checkout). While
   * this job waits it lends its slot: the queue may start one more job — of another project, or of the same one,
   * which then queues behind this one in FIFO order.
   */
  private async lockProject(project: ProjectContext | null, taskId: string): Promise<() => void> {
    if (!project || project.isolation !== 'shared') return () => undefined;
    return this.projectLocks.acquire(project.id, () => {
      this.waiting++;
      this.applyConcurrency();
      this.logger.log(`Task ${taskId} waits for project "${project.slug}" (${this.projectLocks.pending(project.id) - 1} ahead) — its slot is lent out meanwhile`);
      return () => {
        this.waiting--;
        this.applyConcurrency();
      };
    });
  }

  private async process(data: TaskJobData): Promise<void> {
    const { taskId } = data;
    // What the job is about, before anything is claimed: the task's agent (a chat agent has no project lifecycle)
    // and its project (its lock, checkout, mode). A task deleted since it was queued is simply dropped.
    const pre = await this.tasks.getLite(taskId).catch(() => null);
    if (!pre) {
      this.logger.log(`Task ${taskId} is gone — dropping its job`);
      return;
    }
    const agentDef = pre.agentName ? await this.agents.get(pre.agentName).catch(() => null) : null;
    const chat = agentDef?.mode === 'chat';
    const project = chat ? null : await this.projects.contextFor(pre);
    // A busy small machine: hold the start (the task stays `queued`) until the load / memory are back inside the limits. The admin's chat lane never waits.
    if (!chat) {
      const gate = {
        limits: { maxLoadPerCpu: this.config.agentMaxLoadPerCpu, minFreeMemMb: this.config.agentMinFreeMemMb, maxStealPct: this.config.agentMaxStealPct },
        onWait: (why: string) => {
          this.logger.warn(`Task ${taskId} waits to start: ${why}`);
          setHold(taskId, `waiting to start: ${why}`);
        },
      };
      // one at a time and spread out, unless the gap is switched off; the task page says why it is still queued
      if (this.config.agentStartGapMs > 0) setHold(taskId, `waiting for its turn (runs start one at a time, ${Math.round(this.config.agentStartGapMs / 1000)} s apart)`);
      const held = await (this.config.agentStartGapMs > 0 ? this.starts.enter({ ...gate, gapMs: this.config.agentStartGapMs }) : waitForCapacity(gate)).finally(() => clearHold(taskId));
      if (held.waitedMs > 1000) this.logger.log(`Task ${taskId} waited ${Math.round(held.waitedMs / 1000)} s for the machine${held.forced ? ' (starts anyway: waited the maximum)' : ''}`);
      this.capacityHeld = { at: Date.now(), waitedMs: held.waitedMs, forced: held.forced };
    }
    const release = await this.lockProject(project, taskId);
    try {
      await this.processLocked(data, chat, project);
    } finally {
      release();
    }
  }

  private async processLocked(data: TaskJobData, chat: boolean, project: ProjectContext | null): Promise<void> {
    const { taskId, followUpPrompt, attachments } = data;
    // Guarded transition: a job whose task was cancelled, accepted as done or
    // deleted since it was queued is dropped here — never `running` over that;
    // one whose task is already running (a scheduled re-check that fired during
    // a follow-up) is held for after that run instead of a second run alongside.
    const entry = await this.tasks.startRunning(taskId);
    if (entry === 'busy') {
      if (followUpPrompt) {
        this.logger.log(`Task ${taskId} is already running — holding this follow-up for after it`);
        await this.tasks.holdFollowUp(taskId, followUpPrompt, attachments);
      } else {
        this.logger.log(`Task ${taskId} is already running — dropping its duplicate job`);
      }
      return;
    }
    if (entry !== 'started') {
      this.logger.log(`Task ${taskId} is cancelled, done or gone — dropping its job`);
      return;
    }
    this.logger.log(`Processing task ${taskId}${project && !project.isDefault ? ` [project=${project.slug}]` : ''}`);

    try {
      // Chat agents (e.g. the built-in admin) have no repo/worktree/verify/publish
      // lifecycle: every turn just runs and settles as done.
      if (chat || !project) {
        await this.processChat(taskId, followUpPrompt, attachments);
        return;
      }
      const task = await this.tasks.getLite(taskId);
      const shared = project.isolation === 'shared';
      // Where the task works: a docs project's work/ folder (no git); in shared mode the project's checkout;
      // otherwise an existing per-task worktree on follow-ups, or a new one.
      const wt = await this.checkoutFor(project, task, shared);
      if (task.worktreePath !== wt.worktreePath || task.branch !== wt.branch) {
        await this.tasks.attachWorktree(taskId, wt.branch, wt.worktreePath);
      }

      // Top-level tasks may decompose into subtasks; subtasks may not (no nesting).
      const onCreateSubtask = task.parentId
        ? undefined
        : (input: { prompt: string; title?: string; agent?: string }) =>
            this.tasks
              .createSubtask(taskId, { prompt: input.prompt, title: input.title, agentName: input.agent }, undefined, { fromAgent: true })
              .then((t) => ({ id: t.id, title: t.title, reused: (t as { reused?: boolean }).reused }));
      // Same gating: only a decomposing lead can inspect its subtasks.
      const onCheckSubtasks = task.parentId ? undefined : () => this.tasks.subtaskStatuses(taskId);
      const onCompleteSubtask = task.parentId ? undefined : (id: string) => this.tasks.completeSubtask(taskId, id);
      // Any agent may schedule a delayed re-run of its own task ("check back later").
      const onScheduleCheck = async (input: { delaySeconds: number; note?: string }) => {
        const prompt =
          `⏰ Scheduled re-check${input.note ? ` — ${input.note}` : ''}. ` +
          `Re-check the relevant status now (e.g. poll CI via the github MCP). If it is resolved, ` +
          `report done; if it is still pending and you want to keep watching, call schedule_check again.`;
        await this.tasks.scheduleFollowUp(taskId, prompt, input.delaySeconds);
        return { delaySeconds: Math.min(Math.max(Math.round(input.delaySeconds), 30), 3600) };
      };

      const outcome = await this.executor.run({
        taskId,
        ...wt,
        followUpPrompt,
        attachments,
        onCreateSubtask,
        onCheckSubtasks,
        onCompleteSubtask,
        onScheduleCheck,
      });

      // The run has returned, so no agent is live for this task anymore. Finalize
      // unless it already reached a terminal state (e.g. cancelled mid-run). A
      // lingering `needs_approval` here is stale (a killed run whose approval
      // hasn't timed out yet) — treat it as finishable so the task can't orphan.
      const after = await this.tasks.getLite(taskId);
      if (!isTerminalStatus(after.status)) {
        // Structured completion contract (decideStatus): the terminal status comes from
        // what the agent explicitly reported (report_task_status), never from parsing prose.
        const decision = decideStatus(outcome, { chat: false, parentId: after.parentId, requireStatusReport: this.config.requireStatusReport });
        if (decision.kind === 'settle') {
          await this.tasks.setStatus(taskId, decision.status, decision.error);
          this.logger.log(`Task ${taskId} ${decision.status}: ${decision.error.split('\n')[0]}`);
          return;
        }
        // Ran out of steps (maxTurns) before reporting → ask a human whether to
        // continue for more steps instead of silently stalling. On approve the
        // task re-runs; on deny it's stalled. GUARD: once a task has hit the
        // limit maxContinuations times without finishing, stop offering — a
        // non-converging run (weak model grinding, repeating the same failing
        // action) would otherwise loop "40 turns → continue → 40 turns" forever.
        if (decision.kind === 'continuation') {
          const priorContinuations = await this.approvals.continuationCount(taskId);
          if (priorContinuations >= this.config.maxContinuations) {
            // One-shot decomposition hand-back: a TOP-LEVEL task that ground
            // through the limit is probably too big for one run — hand it back to
            // the lead ONCE to split into subtasks instead of implementing.
            // Guarded by an in-memory set so it happens at most once per task
            // (even if the lead ignores the instruction and creates none), which
            // hard-bounds the loop; a second grind lands here and stalls.
            if (!after.parentId && !this.decomposeHandedBack.has(taskId)) {
              this.decomposeHandedBack.add(taskId);
              await this.tasks.continueRun(
                taskId,
                'You have repeatedly hit the step limit — STOP trying to implement this in one run. ' +
                  'Break the remaining work into smaller, independently-runnable subtasks with ' +
                  'create_subtask (one per unit of work), then report your status. Do not implement it all yourself.',
              );
              this.logger.warn(`Task ${taskId} hit step limit — handed back to lead to decompose`);
              return;
            }
            const why = `hit the step limit ${priorContinuations + 1}× without finishing — stopping (raise the agent's maxTurns / AGENT_MAX_TURNS or split the task)`;
            await this.tasks.setStatus(taskId, 'stalled', why);
            this.logger.warn(`Task ${taskId} stalled: ${why}`);
            return;
          }
          await this.approvals.requestContinuation(
            taskId,
            'The agent reached its step limit before finishing. Approve to continue for more steps, or deny to stop.',
          );
          this.logger.log(
            `Task ${taskId} hit the step limit — requested continuation (${priorContinuations + 1}/${this.config.maxContinuations})`,
          );
          return;
        }

        // Clean finish (reported 'done', or unreported with strict mode off).
        // Verification gate: run the project's checks and let the agent fix
        // failures (bounded) before we mark done / push.
        const gate = await this.verifyWithFixes({ taskId, ...wt, project });
        // The verify loop may have been cancelled while iterating.
        if (isTerminalStatus((await this.tasks.getLite(taskId)).status)) {
          this.logger.log(`Task ${taskId} settled during verification — not finalizing`);
          return;
        }
        if (!gate.ok) {
          await this.tasks.setStatus(taskId, 'failed', `verification failed:\n${gate.output}`);
          this.logger.warn(`Task ${taskId} failed verification`);
          return;
        }

        // The agent is finished: the person accepts the result. (A subtask is accepted by its lead, so it is simply done.)
        await this.tasks.setStatus(taskId, decision.status);
        // Publish (best-effort; never fails the task) — code projects only (a docs project has no repository):
        //  - shared mode: push the current branch straight to the project's origin (no PR) if
        //    a repo is configured — the agent's commits go up as-is.
        //  - worktree mode: push the task branch + open/refresh a PR.
        if (project.kind !== 'code') {
          // nothing to publish
        } else if (shared) {
          // Shared mode: push straight to origin, no PR → record it as pushedTo.
          const pushedTo = await this.github.pushSharedWorkspace(project, wt.branch).catch((err) => {
            this.logger.warn(`shared push failed: ${(err as Error).message}`);
            return null;
          });
          if (pushedTo) await this.tasks.attachPushedTo(taskId, pushedTo);
        } else {
          // Worktree mode: push the task branch + open/refresh a real PR → prUrl.
          const prUrl = await this.github
            .publishResult(project, {
              branch: wt.branch,
              title: task.title,
              body: `Automated change by an agent for task \`${taskId}\`.\n\n${task.prompt}`,
            })
            .catch((err) => {
              this.logger.warn(`publishResult failed: ${(err as Error).message}`);
              return null;
            });
          if (prUrl) await this.tasks.attachPr(taskId, prUrl);
        }
      }
      this.logger.log(`Task ${taskId} finished`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // If the task was cancelled mid-run, leave it cancelled (don't fail it); if it
      // was deleted mid-run, there is no row to fail and nothing to report (E-23).
      const current = await this.tasks.getLite(taskId).catch(() => null);
      if (!current) {
        this.logger.log(`Task ${taskId} was deleted during its run`);
        return;
      }
      if (current.status === 'cancelled') {
        this.logger.log(`Task ${taskId} cancelled`);
        return;
      }
      this.logger.error(`Task ${taskId} failed: ${message}`);
      await this.tasks.setStatus(taskId, 'failed', message);
      throw err; // surface to BullMQ for visibility
    } finally {
      // Tear down any ephemeral worktree preview started during this run.
      this.preview.stop(taskId);
      // Only now is the worker fully out of the task's worktree: the next held
      // follow-up may start (the drain deferred by setStatus — X-Q-3).
      await this.tasks.runSettled(taskId).catch((err) =>
        this.logger.warn(`settle failed for ${taskId}: ${(err as Error).message}`),
      );
      // Fan-in: resume the lead once all its subtasks have finished.
      await this.tasks.fanInAfterSettle(taskId).catch((err) =>
        this.logger.warn(`fan-in failed for ${taskId}: ${(err as Error).message}`),
      );
    }
  }

  /** The folder (and branch) a task of the project works in. */
  private async checkoutFor(project: ProjectContext, task: { worktreePath: string | null; branch: string | null; id: string }, shared: boolean): Promise<{ worktreePath: string; branch: string }> {
    if (project.kind !== 'code') {
      const dir = docsWorkDirOf(project);
      await mkdir(dir, { recursive: true });
      return { worktreePath: dir, branch: '' };
    }
    if (shared) return this.worktrees.useSharedRepo(project);
    if (task.worktreePath && task.branch) return { worktreePath: task.worktreePath, branch: task.branch };
    return this.worktrees.createForTask(project, task.id);
  }

  /** One chat turn: run the agent in the agent-config dir and settle as done (or failed on a run error). */
  private async processChat(taskId: string, followUpPrompt?: string, attachments?: string[]): Promise<void> {
    const outcome = await this.executor.run({
      taskId,
      worktreePath: this.config.agentDir,
      branch: '',
      followUpPrompt,
      attachments,
    });
    const after = await this.tasks.getLite(taskId);
    if (isTerminalStatus(after.status)) return; // cancelled mid-turn — leave it
    const decision = decideStatus(outcome, { chat: true, parentId: after.parentId, requireStatusReport: this.config.requireStatusReport });
    if (decision.kind === 'settle') {
      await this.tasks.setStatus(taskId, decision.status, decision.error);
      this.logger.warn(`Chat task ${taskId} ${decision.status}: ${decision.error.slice(0, 200)}`);
      return;
    }
    // A chat turn never asks for a continuation: out of steps is just the end of the turn.
    await this.tasks.setStatus(taskId, decision.kind === 'finish' ? decision.status : after.parentId ? 'done' : 'review');
    this.logger.log(`Chat task ${taskId} turn finished`);
  }

  /**
   * Run the project's verification gate; on failure, hand the output back to the agent for
   * up to the project's verifyMaxAttempts fix iterations, re-verifying each time.
   */
  private async verifyWithFixes(ctx: { taskId: string; worktreePath: string; branch: string; project: ProjectContext }): Promise<VerifyResult> {
    const { project } = ctx;
    if (!project.verifyCommands.length) return { ran: false, ok: true, output: '' };
    // The same cwd the agent worked in: the configured subdirectory (e.g. a monorepo package), else the checkout root.
    const cwd = await resolveWorkDir(ctx.worktreePath, project.repoSubdir, (m) => this.logger.warn(m));
    let result = await this.verification.verify(project.verifyCommands, cwd);
    if (!result.ran || result.ok) return result;

    const maxAttempts = project.verifyMaxAttempts;
    for (let attempt = 1; attempt <= maxAttempts && !result.ok; attempt++) {
      // Stop launching fix runs if the task was cancelled/deleted between rounds.
      if (isTerminalStatus((await this.tasks.getLite(ctx.taskId)).status)) break;
      this.logger.log(`Task ${ctx.taskId}: verification failed — auto-fix ${attempt}/${maxAttempts}`);
      await this.executor.run({
        taskId: ctx.taskId,
        worktreePath: ctx.worktreePath,
        branch: ctx.branch,
        followUpPrompt: `Your change did not pass verification. Fix the problems below, then stop.\n\n${result.output}`,
        // a fix run needs no extra "report your status" turn (the gate re-verifies anyway)
        skipReportingResume: true,
      });
      result = await this.verification.verify(project.verifyCommands, cwd);
    }
    return result;
  }
}
