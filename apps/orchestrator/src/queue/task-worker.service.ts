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
import { VerificationService, type VerifyResult } from './verification.service';
import { TaskQueue, type TaskJobData } from './queue.constants';

/** Append the agent's salvaged last message (its implicit question) to a stall
 *  reason so escalation carries the real content, not just a generic string. */
function withQuestion(base: string, finalText?: string): string {
  return finalText ? `${base} — agent's last message:\n${finalText}` : base;
}

/**
 * Consumer side of the task queue. For each job it drives the task lifecycle:
 *   queued -> running -> (worktree) -> executor -> done | failed
 * and supervises the agent run via the injected AgentExecutor.
 */
@Injectable()
export class TaskWorkerService implements OnModuleInit {
  private readonly logger = new Logger(TaskWorkerService.name);
  /** Tasks already handed back to the lead once for decomposition (one-shot). */
  private readonly decomposeHandedBack = new Set<string>();

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
  ) {}

  async onModuleInit(): Promise<void> {
    // A fresh process has nothing running — clear orphaned `running` rows left
    // by a previous (crashed) process BEFORE the worker starts, so a resumed
    // job can't be flipped back to `stalled` by the reconcile mid-run.
    await this.tasks.reconcileOrphanedRunning().catch((err) => {
      this.logger.warn(`Orphan reconciliation failed: ${(err as Error).message}`);
    });
    await this.queue.startWorker((data) => this.process(data), this.config.agentConcurrency);
  }

  private async process(data: TaskJobData): Promise<void> {
    const { taskId, followUpPrompt, attachments } = data;
    this.logger.log(`Processing task ${taskId}`);
    await this.tasks.setStatus(taskId, 'running');

    try {
      const task = await this.tasks.get(taskId);
      // Shared mode: every task works in the main repo dir. Otherwise reuse an
      // existing per-task worktree on follow-ups, or create one.
      const wt = this.config.workspaceShared
        ? await this.worktrees.useSharedRepo()
        : task.worktreePath && task.branch
          ? { worktreePath: task.worktreePath, branch: task.branch }
          : await this.worktrees.createForTask(taskId);
      if (task.worktreePath !== wt.worktreePath || task.branch !== wt.branch) {
        await this.tasks.attachWorktree(taskId, wt.branch, wt.worktreePath);
      }

      // Top-level tasks may decompose into subtasks; subtasks may not (no nesting).
      const onCreateSubtask = task.parentId
        ? undefined
        : (input: { prompt: string; title?: string; agent?: string }) =>
            this.tasks
              .createSubtask(taskId, { prompt: input.prompt, title: input.title, agentName: input.agent })
              .then((t) => ({ id: t.id, title: t.title }));
      // Same gating: only a decomposing lead can inspect its subtasks.
      const onCheckSubtasks = task.parentId ? undefined : () => this.tasks.subtaskStatuses(taskId);
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
        onScheduleCheck,
      });

      // The run has returned, so no agent is live for this task anymore. Finalize
      // unless it already reached a terminal state (e.g. cancelled mid-run). A
      // lingering `needs_approval` here is stale (a killed run whose approval
      // hasn't timed out yet) — treat it as finishable so the task can't orphan.
      const after = await this.tasks.get(taskId);
      if (!isTerminalStatus(after.status)) {
        // Structured completion contract: the terminal status comes from what the
        // agent explicitly reported (report_task_status), never from parsing prose.
        //  - blocked/failed report → honor it (skip verify/push).
        //  - abnormal end without a 'done' report → `stalled` (outcome unknown).
        //  - strict mode: a clean finish with no report at all → `stalled`.
        if (outcome.reported === 'blocked') {
          await this.tasks.setStatus(taskId, 'blocked', outcome.reportedSummary ?? 'agent reported blocked');
          this.logger.log(`Task ${taskId} blocked (agent-reported)`);
          return;
        }
        if (outcome.reported === 'failed') {
          await this.tasks.setStatus(taskId, 'failed', outcome.reportedSummary ?? 'agent reported failure');
          this.logger.log(`Task ${taskId} failed (agent-reported)`);
          return;
        }
        // Ran out of steps (maxTurns) before reporting → ask a human whether to
        // continue for more steps instead of silently stalling. On approve the
        // task re-runs; on deny it's stalled. GUARD: once a task has hit the
        // limit maxContinuations times without finishing, stop offering — a
        // non-converging run (weak model grinding, repeating the same failing
        // action) would otherwise loop "40 turns → continue → 40 turns" forever.
        if (outcome.maxTurns && !outcome.reported) {
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
            const why = `hit the step limit ${priorContinuations + 1}× without finishing — stopping (raise AGENT_MAX_TURNS or split the task)`;
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
        if (outcome.errored && outcome.reported !== 'done') {
          const base = outcome.timedOut
            ? 'run timed out without a status report'
            : 'run ended abnormally without a status report';
          await this.tasks.setStatus(taskId, 'stalled', withQuestion(base, outcome.finalText));
          this.logger.warn(`Task ${taskId} stalled: ${base}`);
          return;
        }
        if (!outcome.reported && this.config.requireStatusReport) {
          // Salvage the agent's last message as the reason so an implicit question
          // (agent stopped waiting for an answer) survives to be escalated.
          const base = 'run finished without calling report_task_status';
          await this.tasks.setStatus(taskId, 'stalled', withQuestion(base, outcome.finalText));
          this.logger.warn(`Task ${taskId} stalled: no status report (strict mode)`);
          return;
        }

        // Clean finish (reported 'done', or unreported with strict mode off).
        // Verification gate: run the project's checks and let the agent fix
        // failures (bounded) before we mark done / push.
        const gate = await this.verifyWithFixes({ taskId, ...wt });
        // The verify loop may have been cancelled while iterating.
        if (isTerminalStatus((await this.tasks.get(taskId)).status)) {
          this.logger.log(`Task ${taskId} settled during verification — not finalizing`);
          return;
        }
        if (!gate.ok) {
          await this.tasks.setStatus(taskId, 'failed', `verification failed:\n${gate.output}`);
          this.logger.warn(`Task ${taskId} failed verification`);
          return;
        }

        await this.tasks.setStatus(taskId, 'done');
        // Publish (best-effort; never fails the task):
        //  - shared mode: push the current branch straight to origin (no PR) if
        //    a repo is configured — the agent's commits go up as-is.
        //  - worktree mode: push the task branch + open/refresh a PR.
        if (this.config.workspaceShared) {
          // Shared mode: push straight to origin, no PR → record it as pushedTo.
          const pushedTo = await this.github.pushSharedWorkspace(wt.branch).catch((err) => {
            this.logger.warn(`shared push failed: ${(err as Error).message}`);
            return null;
          });
          if (pushedTo) await this.tasks.attachPushedTo(taskId, pushedTo);
        } else {
          // Worktree mode: push the task branch + open/refresh a real PR → prUrl.
          const prUrl = await this.github
            .publishResult({
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
      // If the task was cancelled mid-run, leave it cancelled (don't fail it).
      const current = await this.tasks.get(taskId).catch(() => null);
      if (current?.status === 'cancelled') {
        this.logger.log(`Task ${taskId} cancelled`);
        return;
      }
      this.logger.error(`Task ${taskId} failed: ${message}`);
      await this.tasks.setStatus(taskId, 'failed', message);
      throw err; // surface to BullMQ for visibility
    } finally {
      // Tear down any ephemeral worktree preview started during this run.
      this.preview.stop(taskId);
      // Fan-in: resume the lead once all its subtasks have finished.
      await this.tasks.fanInAfterSettle(taskId).catch((err) =>
        this.logger.warn(`fan-in failed for ${taskId}: ${(err as Error).message}`),
      );
    }
  }

  /**
   * Run the verification gate; on failure, hand the output back to the agent for
   * up to verifyMaxAttempts fix iterations, re-verifying each time.
   */
  private async verifyWithFixes(ctx: {
    taskId: string;
    worktreePath: string;
    branch: string;
  }): Promise<VerifyResult> {
    let result = await this.verification.verify(ctx.worktreePath);
    if (!result.ran || result.ok) return result;

    const maxAttempts = await this.settings.verifyMaxAttempts();
    for (let attempt = 1; attempt <= maxAttempts && !result.ok; attempt++) {
      // Stop launching fix runs if the task was cancelled/deleted between rounds.
      if (isTerminalStatus((await this.tasks.get(ctx.taskId)).status)) break;
      this.logger.log(`Task ${ctx.taskId}: verification failed — auto-fix ${attempt}/${maxAttempts}`);
      await this.executor.run({
        taskId: ctx.taskId,
        worktreePath: ctx.worktreePath,
        branch: ctx.branch,
        followUpPrompt: `Your change did not pass verification. Fix the problems below, then stop.\n\n${result.output}`,
      });
      result = await this.verification.verify(ctx.worktreePath);
    }
    return result;
  }
}
