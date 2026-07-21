import type { CreateSubtaskInput } from '@lds/agent-runner';

/**
 * Boundary between the queue worker and the agent runtime. The worker prepares
 * the worktree and lifecycle, then hands off to an AgentExecutor. The real
 * implementation (driving @lds/agent-runner) is provided in the agent-runtime
 * milestone; a stub stands in until then.
 */
export interface TaskRunContext {
  taskId: string;
  worktreePath: string;
  branch: string;
  /** Follow-up prompt that continues an existing agent session, if any. */
  followUpPrompt?: string;
  /** Attachment filenames sent with this message (recorded on the prompt event). */
  attachments?: string[];
  /**
   * When set, the agent may decompose this task into subtasks via a
   * `create_subtask` tool. The worker wires it for top-level tasks only, so
   * subtasks can't recursively spawn more.
   */
  onCreateSubtask?: (input: CreateSubtaskInput) => Promise<{ id: string; title: string }>;
  /** When set, the agent can inspect this task's subtasks (status + result). */
  onCheckSubtasks?: () => Promise<{ id: string; title: string; status: string; summary: string }[]>;
  /** When set, the agent can schedule a delayed re-run of this task ("check back later"). */
  onScheduleCheck?: (input: { delaySeconds: number; note?: string }) => Promise<{ delaySeconds: number }>;
}

/**
 * What a run produced, so the worker can decide the terminal status without
 * parsing prose. `reported` is the authoritative agent-declared outcome (via
 * report_task_status); `errored`/`timedOut` describe abnormal ends.
 */
export interface AgentRunOutcome {
  /** Outcome the agent explicitly declared, if it called report_task_status. */
  reported: 'done' | 'failed' | 'blocked' | null;
  reportedSummary?: string;
  /** The run ended in error/abort rather than a clean finish. */
  errored: boolean;
  /** The run was aborted by our timeout/watchdog (vs. a user cancel). */
  timedOut: boolean;
  /** The run ended by exhausting the max-turns budget (offer to continue). */
  maxTurns?: boolean;
  /** The agent's last assistant message when it ended WITHOUT a report — the
   *  implicit question/handoff to escalate (parent lead or the user). */
  finalText?: string;
}

export abstract class AgentExecutor {
  /** Run (or continue) an agent for the task. Resolves when the run ends. */
  abstract run(ctx: TaskRunContext): Promise<AgentRunOutcome>;

  /** Abort an in-flight run for a task, if one is active. Default: no-op. */
  cancel(_taskId: string): void {
    // overridden by executors that track running agents
  }
}
