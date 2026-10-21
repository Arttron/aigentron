import { classifyProviderFailure } from '../agent/run-outcome';
import type { AgentRunOutcome } from '../agent/agent-executor';

/** What the worker does with a task after its run returned (E-33: one mapping for code and chat agents). */
export type RunDecision =
  /** The task ends in this status now (nothing else runs). */
  | { kind: 'settle'; status: 'blocked' | 'failed' | 'stalled'; error: string }
  /** The run ran out of steps without a report: ask a person whether to continue (the worker applies the continuation cap). */
  | { kind: 'continuation' }
  /** A clean finish: for a code agent the verification gate runs first, then the task ends in `status`. */
  | { kind: 'finish'; status: 'review' | 'done' };

export interface RunDecisionContext {
  /** A conversational agent: no worktree, no verify, no continuation prompts — every turn just settles. */
  chat: boolean;
  /** A subtask is accepted by its lead, so it ends `done`; a top-level task waits for the person (`review`). */
  parentId: string | null;
  /** Strict mode: a clean finish without report_task_status is `stalled`, not a success. */
  requireStatusReport: boolean;
}

/** How much of an error / summary text is kept on the task. */
const ERROR_MAX = 500;

/** Append the agent's salvaged last message (its implicit question) to a stall
 *  reason so escalation carries the real content, not just a generic string. */
function withQuestion(base: string, finalText?: string): string {
  return finalText ? `${base} — agent's last message:\n${finalText}` : base;
}

/**
 * The structured completion contract, as a pure function: the terminal status comes from what the
 * agent explicitly reported (report_task_status), never from parsing prose.
 *  - blocked/failed report → honoured (verify/push are skipped);
 *  - out of steps without a report → a continuation is offered (code agents);
 *  - an abnormal end without a 'done' report → `stalled` (outcome unknown; `failed` for a chat turn);
 *  - strict mode: a clean finish with no report at all → `stalled`;
 *  - otherwise a clean finish: `review` (a person accepts), or `done` for a subtask (its lead does).
 */
export const MEMORY_STOP_MESSAGE =
  'The machine was about to run out of memory, so this run was stopped before the system killed the whole service. The work done so far stays; press Continue when the server is calmer (or give it more memory / swap).';

export function decideStatus(outcome: AgentRunOutcome, ctx: RunDecisionContext): RunDecision {
  const finish: RunDecision = { kind: 'finish', status: ctx.parentId ? 'done' : 'review' };
  if (outcome.memoryStopped && outcome.reported !== 'done') {
    return ctx.chat ? { kind: 'settle', status: 'failed', error: MEMORY_STOP_MESSAGE } : { kind: 'settle', status: 'stalled', error: MEMORY_STOP_MESSAGE };
  }
  if (ctx.chat) {
    if (outcome.errored && outcome.reported !== 'done') {
      const why = outcome.timedOut ? 'chat turn timed out' : (outcome.finalText ?? 'chat turn failed');
      return { kind: 'settle', status: 'failed', error: why.slice(0, ERROR_MAX) };
    }
    // e.g. a token budget stopped the turn before it started — say so instead of a silent "done"
    if (outcome.reported === 'blocked') return { kind: 'settle', status: 'blocked', error: (outcome.reportedSummary ?? 'agent reported blocked').slice(0, ERROR_MAX) };
    if (outcome.reported === 'failed') return { kind: 'settle', status: 'failed', error: (outcome.reportedSummary ?? 'agent reported failure').slice(0, ERROR_MAX) };
    return finish;
  }
  if (outcome.reported === 'blocked') return { kind: 'settle', status: 'blocked', error: outcome.reportedSummary ?? 'agent reported blocked' };
  if (outcome.reported === 'failed') return { kind: 'settle', status: 'failed', error: outcome.reportedSummary ?? 'agent reported failure' };
  if (outcome.maxTurns && !outcome.reported) return { kind: 'continuation' };
  if (outcome.errored && outcome.reported !== 'done') {
    // the provider's own error text (X-FO-1/6) is the reason a person can act on, e.g. "rate limit …" or "model not supported"
    const base = outcome.timedOut
      ? 'run timed out without a status report'
      : outcome.errorText
        ? `the provider failed: ${outcome.errorText}${classifyProviderFailure(outcome.errorText) === 'quota' ? ' — its limit / plan looks used up: add a fallback provider to this agent (Agents → Fallback providers) or wait for the limit to reset, then send the task a message to continue' : ''}`
        : 'run ended abnormally without a status report';
    return { kind: 'settle', status: 'stalled', error: withQuestion(base, outcome.finalText) };
  }
  if (!outcome.reported && ctx.requireStatusReport) {
    // The agent's last message is kept as the reason so an implicit question (it stopped waiting for an answer) survives to be escalated.
    return { kind: 'settle', status: 'stalled', error: withQuestion('run finished without calling report_task_status', outcome.finalText) };
  }
  return finish;
}
