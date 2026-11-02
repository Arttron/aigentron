/** A message of at least this length is «the answer»; a final line shorter than SHORT_CLOSING after it is only a closing remark. */
export const LONG_ANSWER = 400;
export const SHORT_CLOSING = 240;

/** Tools that do not count as «work after the answer» (reporting, saving the document itself, showing, clock). */
const QUIET_TOOL = /report_task_status|heartbeat|workspace_save|workspace_note|show_images|current_time/;
export const isQuietTool = (toolName: string): boolean => QUIET_TOOL.test(toolName);

/**
 * An agent writes its answer as a message, then ends with a short «answered above». The final message is all that a chat channel or the «messages
 * only» view shows, so the long message goes in front of such a closing line. Returns the text the final result should carry.
 */
export function finalWithAnswer(lastLongAnswer: string, closing: string): string {
  const c = closing.trim();
  if (!lastLongAnswer || c.length >= SHORT_CLOSING || c.includes(lastLongAnswer.slice(0, 120))) return closing;
  return `${lastLongAnswer}\n\n${c}`.trim();
}

/**
 * An event of the reporting-resume turn (the extra turn that asks an agent that ended without report_task_status to record its outcome): its final
 * `result` is a reply to OUR prompt, not the agent's answer, so it is shown as a note. Otherwise it would be the newest `result` of the task and a chat
 * channel would post «Status reported.» as the answer (and the dashboard would show the long answer twice).
 */
export function resumeTurnEvent<T extends { kind: string; text?: string }>(e: T): T | { kind: 'stderr'; text: string } {
  return e.kind === 'result' ? { kind: 'stderr', text: `↻ ${String(e.text ?? '').trim().slice(0, 300) || 'outcome recorded'}` } : e;
}

/**
 * Follows a run's events to find «the answer» a final result must carry (see finalWithAnswer). One tracker per run attempt; it is told every event.
 * The answer is CONSUMED by the first final result: the reporting-resume turn that follows a run which ended without report_task_status ends with
 * its own short result, and must not carry the long answer a second time (the same message appeared twice after «resuming once to record the outcome»).
 */
export class AnswerTracker {
  private longAnswer = '';

  /** An assistant message. */
  assistant(text: string): void {
    if (text.trim().length >= LONG_ANSWER) this.longAnswer = text.trim();
  }

  /** A tool call: any tool but the quiet ones makes the earlier message a stage of the run, not the answer. */
  tool(name: string): void {
    if (!isQuietTool(name)) this.longAnswer = '';
  }

  /** The final result's text, with the answer in front of a short closing; the answer is used up by it. */
  result(text: string): string {
    const out = finalWithAnswer(this.longAnswer, text);
    this.longAnswer = '';
    return out;
  }
}
