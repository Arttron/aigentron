/** Discussion between agents — pure helpers (unit-tested). */

export const MIN_PARTICIPANTS = 2;
export const MAX_PARTICIPANTS = 6;
export const MAX_ROUNDS = 8;
export const DEFAULT_ROUNDS = 3;
/** How much of the conversation a participant is shown (older turns are cut from the front). */
export const TRANSCRIPT_CHARS = 9000;
export const AGREED_MARK = '[[AGREED]]';

export interface Turn {
  /** agent name, or "Human" for something the person added */
  speaker: string;
  text: string;
  /** the message ended with the agreement mark (the mark itself is stripped from `text`) */
  agreed?: boolean;
}

/** Participants: distinct (case-insensitive), 2–6. Returns a cleaned list or an error text. */
export function cleanParticipants(input: unknown): { agents: string[] } | { error: string } {
  const seen = new Set<string>();
  const agents: string[] = [];
  for (const raw of Array.isArray(input) ? input : []) {
    const n = String(raw ?? '').trim();
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    agents.push(n);
  }
  if (agents.length < MIN_PARTICIPANTS) return { error: `Pick at least ${MIN_PARTICIPANTS} different agents to discuss.` };
  if (agents.length > MAX_PARTICIPANTS) return { error: `At most ${MAX_PARTICIPANTS} agents can take part.` };
  return { agents };
}

export function cleanRounds(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_ROUNDS, Math.max(1, n)) : DEFAULT_ROUNDS;
}

/** Keep the newest turns that fit; say how many were left out. */
export function trimTranscript(turns: readonly Turn[], maxChars = TRANSCRIPT_CHARS): { shown: Turn[]; omitted: number } {
  const shown: Turn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const cost = t.text.length + t.speaker.length + 8;
    if (shown.length && used + cost > maxChars) break;
    shown.unshift(t);
    used += cost;
  }
  return { shown, omitted: turns.length - shown.length };
}

/** What a participant is asked on its turn. */
export function buildTurnPrompt(o: { topic: string; speaker: string; participants: readonly string[]; turns: readonly Turn[]; turnNumber: number; totalTurns: number; humanHint?: boolean }): string {
  const others = o.participants.filter((p) => p !== o.speaker);
  const { shown, omitted } = trimTranscript(o.turns);
  const convo = shown.length
    ? `${omitted ? `(${omitted} earlier message(s) left out)\n` : ''}${shown.map((t) => `${t.speaker}: ${t.text.trim()}`).join('\n\n')}`
    : '(nobody has spoken yet — you open the discussion)';
  return [
    `You are taking part in a round-table discussion in a chat, as "${o.speaker}", together with ${others.join(', ')}${o.humanHint ? ' and the human who started it' : ''}.`,
    `Topic: ${o.topic.trim()}`,
    '',
    'The conversation so far:',
    convo,
    '',
    `This is turn ${o.turnNumber} of ${o.totalTurns}. Speak in your own role and voice. Rules:`,
    '- Answer the other participants: agree, object, add what they missed, ask a pointed question — do not repeat what was already said.',
    '- Be concrete and brief (at most ~150 words). No greetings, no preamble, no sign-off; do not write "name:" before your message.',
    '- Say plainly where you disagree and why; do not agree just to be polite.',
    `- If you fully agree with the others and have nothing to add, say so in one sentence and end with ${AGREED_MARK}.`,
    '- If the human added a message, answer it first.',
    '- Do not change files or run commands; this is a conversation.',
  ].join('\n');
}

/** The closing turn: one participant sums it up. */
export function buildSummaryPrompt(o: { topic: string; speaker: string; participants: readonly string[]; turns: readonly Turn[] }): string {
  const { shown, omitted } = trimTranscript(o.turns, TRANSCRIPT_CHARS * 1.5);
  return [
    `The round-table discussion (${o.participants.join(', ')}) is over. You are "${o.speaker}" and you write the conclusion for the human.`,
    `Topic: ${o.topic.trim()}`,
    '',
    omitted ? `(${omitted} earlier message(s) left out)` : '',
    shown.map((t) => `${t.speaker}: ${t.text.trim()}`).join('\n\n'),
    '',
    'Write the outcome in at most 200 words: what was agreed, where the participants still disagree (and why), and the recommended next step. Be fair to every participant; do not invent points nobody made.',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

/** Stop early when every participant's latest message ends with the agreement mark (a full round of agreement). */
export function allAgreed(turns: readonly Turn[], participants: readonly string[]): boolean {
  if (turns.length < participants.length) return false;
  const lastRound = turns.slice(-participants.length);
  const speakers = new Set(lastRound.map((t) => t.speaker));
  return participants.every((p) => speakers.has(p)) && lastRound.every((t) => t.agreed ?? t.text.includes(AGREED_MARK));
}

/** Drop the agreement mark from a message before it is shown. */
export const stripMark = (text: string): string => text.replaceAll(AGREED_MARK, '').trim();
