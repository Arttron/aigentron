/**
 * What a model is told when it takes over a conversation it has no memory of: a stored session that cannot be resumed, or a stronger step of the escalation
 * ladder. The earlier messages are context, not orders: a person changes their mind in a later message (new search words, a filter, a place), and a schedule's
 * text is edited between runs. Without this rule a model that reads «original request: …» first follows the OLD request.
 */
export const LATER_WINS = "Where a later message changes or contradicts the original request (search words, filters, places, formats, what to skip), the LATER message wins — follow the newest instructions, not the first ones.";

/**
 * A task that a schedule repeats: the schedule's text comes with every run, so it is always the LATEST message — but the person's own messages in the
 * conversation («change the next runs: add this parameter») adjust all later runs and must win over it, not be dropped because the schedule spoke last.
 */
export const SCHEDULED_RULE = "This task is repeated by a schedule: the schedule's text comes with every run. The person's own messages in this conversation adjust ALL later runs (a new parameter, a changed filter, something to skip or add) and stay in force; where such a message conflicts with the schedule's text, the person's message wins. Only a message that takes an adjustment back, or a schedule text that clearly replaces it, ends it.";

/** The note placed before a message when the earlier session could not be resumed. */
export function lostSessionNote(originalRequest: string, history: string, scheduled = false): string {
  return `(The earlier session of this task could not be resumed. Its original request: ${originalRequest.slice(0, 1500)}\nThe conversation so far, oldest first:\n${history}\n${scheduled ? SCHEDULED_RULE : LATER_WINS}\nContinue from here with the person's new message below.)\n`;
}

const STANDING_MAX_MESSAGES = 8;
const STANDING_MAX_CHARS = 600;
/** «thanks», «ok» are not instructions */
const STANDING_MIN_CHARS = 12;

/**
 * The person's standing instructions in a scheduled task, found in its conversation: the schedule sends its text again at every run, so a text that occurs more
 * than once is the schedule's; the first message is the schedule's too, and so is the run's own message. What is left — said once, by a person — is a
 * change to the next runs. Repeated in every run's message, so that a model that has not seen the conversation (another model, a fresh session) still has them.
 */
export function standingInstructions(promptTexts: string[], currentText: string): string {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const counts = new Map<string, number>();
  for (const t of promptTexts) counts.set(norm(t), (counts.get(norm(t)) ?? 0) + 1);
  const cur = norm(currentText);
  const mine = promptTexts
    .slice(1)
    .map(norm)
    .filter((t) => t.length >= STANDING_MIN_CHARS && t !== cur && counts.get(t) === 1);
  if (!mine.length) return '';
  const lines = mine.slice(-STANDING_MAX_MESSAGES).map((t) => `- ${t.length > STANDING_MAX_CHARS ? `${t.slice(0, STANDING_MAX_CHARS)}…` : t}`);
  return `Standing instructions the person gave in this conversation — they adjust EVERY run, win over the schedule's text where they conflict, and stay in force until the person takes them back:\n${lines.join('\n')}`;
}

/** The hand-over for a stronger model that starts a fresh session after a cheaper one failed. */
export const escalationNote = (originalRequest: string): string => `An earlier attempt on a cheaper model already made the changes now in the working tree. The original request of this task:\n${originalRequest.slice(0, 3000)}\n${LATER_WINS}`;
