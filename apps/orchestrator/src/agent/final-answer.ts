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
