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
  /**
   * Do not resume the session once more to force a report_task_status when the
   * run ends without one (E-07): for a verify-fix or schedule-check run the
   * caller decides the outcome itself (it re-verifies), so the extra full pass
   * over the context would only cost tokens.
   */
  skipReportingResume?: boolean;
  /** Attachment filenames sent with this message (recorded on the prompt event). */
  attachments?: string[];
  /**
   * When set, the agent may decompose this task into subtasks via a
   * `create_subtask` tool. The worker wires it for top-level tasks only, so
   * subtasks can't recursively spawn more.
   */
  onCreateSubtask?: (input: CreateSubtaskInput) => Promise<{ id: string; title: string; reused?: boolean }>;
  /** The lead accepts one of its subtasks as done. */
  onCompleteSubtask?: (id: string) => Promise<string>;
  /** When set, the agent can inspect this task's subtasks (status + result). */
  onCheckSubtasks?: () => Promise<{ id: string; title: string; status: string; summary: string }[]>;
  /** When set, the agent can schedule a delayed re-run of this task ("check back later"). */
  onScheduleCheck?: (input: { delaySeconds: number; note?: string }) => Promise<{ delaySeconds: number }>;
  /**
   * One turn of a discussion between agents: run THIS agent (instead of the task's own) as a conversational, read-only participant on
   * `followUpPrompt`; its reply is stored as a `discussion` message by that speaker and handed back in `collect.text`.
   */
  discussion?: {
    agent: string;
    collect: { text: string; /** set when the turn ended in an error (then `text` stays empty) */ error?: string };
    /** The first turn also records what the human asked, as the opening message of the conversation. */
    opening?: { text: string; attachments?: string[] };
  };
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
  /** The run was stopped by the memory guard: the machine was about to run out of memory (the kernel would have killed the whole service). */
  memoryStopped?: boolean;
  /** The run ended by exhausting the max-turns budget (offer to continue). */
  maxTurns?: boolean;
  /** The agent's last assistant message when it ended WITHOUT a report — the
   *  implicit question/handoff to escalate (parent lead or the user). */
  finalText?: string;
  /**
   * The provider's/runtime's own error when `errored` (one paragraph, ≤500
   * chars; never set for a cancel/timeout) — what `task.error` should say
   * instead of "run ended abnormally" when every provider failed (X-FO-6) or a
   * follow-up's provider failed (X-FO-1).
   */
  errorText?: string;
}

export abstract class AgentExecutor {
  /** Run (or continue) an agent for the task. Resolves when the run ends. */
  abstract run(ctx: TaskRunContext): Promise<AgentRunOutcome>;

  /** Abort an in-flight run for a task, if one is active. Default: no-op. */
  cancel(_taskId: string): void {
    // overridden by executors that track running agents
  }
}
