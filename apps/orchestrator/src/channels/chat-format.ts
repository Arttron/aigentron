/**
 * Pure text/keyboard formatting for chat messages (no Nest, no transport) — what a task outcome, a question or an
 * approval looks like in a chat. Unit-tested; the manager only decides WHEN to send.
 */
import type { AgentLogEvent, AgentQuestion, TaskStatus } from '@lds/shared';
import type { MessageButton } from './channel-adapter';

/** Final-outcome reaction for a settled task — mirrors the icon already used
 *  in the result message text, plus 'cancelled' (which gets no result message
 *  of its own; the /cancel command/button already confirmed synchronously). */
export function reactionIcon(status: TaskStatus): string {
  switch (status) {
    case 'done':
    case 'review':
      return '✅';
    case 'blocked':
      return '⛔';
    case 'cancelled':
      return '🛑';
    default:
      return '❌'; // failed, stalled
  }
}

/**
 * Compact (≤~100 char) status line for a task's live-editable channel
 * message — mirrors the web dashboard's live transcript, but far too verbose
 * to forward as-is (tool_result can be an entire file's contents, assistant
 * text can run to paragraphs). Prefers a field that's already short (tool_use
 * text is pre-summarized by the agent runner — "Bash ls -la", not raw JSON)
 * over showing raw content; classifies to null (not shown) for kinds with
 * nothing short worth surfacing — prompt/system/tool_result/result all either
 * duplicate what the human already sees or are unbounded in size.
 */
export function compactProcessLine(kind: AgentLogEvent['kind'], text: string): string | null {
  const withIcon = (icon: string) => {
    const s = `${icon} ${text}`;
    return s.length > 100 ? `${s.slice(0, 99).trimEnd()}…` : s;
  };
  switch (kind) {
    case 'tool_use':
      return withIcon('🔧');
    case 'delegation':
      return withIcon('🤝');
    case 'assistant':
      return withIcon('💭');
    case 'stderr':
      return withIcon('⚠️');
    default:
      return null;
  }
}

/** A reply carries what it quotes: give the agent that context in front of the message ("Replying to «…»"). */
export function withQuote(text: string, quoted?: string): string {
  const q = (quoted ?? '').replace(/\s+/g, ' ').trim();
  return q ? `↩︎ Replying to «${q.length > 400 ? `${q.slice(0, 400)}…` : q}»\n\n${text}` : text;
}

/** A settled task's message for its chat. `prefix` marks a subtask shown in its parent's chat ("↳ Subtask "). */
export function resultMessage(i: { status: TaskStatus; title: string; body: string; prefix: string; prUrl?: string | null; progress: boolean }): string {
  const icon = reactionIcon(i.status);
  // The agent's work is finished (a top-level task: waiting for the person to accept it; a subtask: done for its lead).
  const answered = i.status === 'review' || i.status === 'done';
  // A finished task's message carries just the agent's answer (the title/status header is system information — shown only with
  // /progress on, or when something needs attention). A subtask's answer says which subtask it is.
  const header = answered ? `${i.prefix}${icon} «${i.title}»` : `${i.prefix}${icon} «${i.title}» — ${i.status}`;
  let text = answered && !i.progress ? (i.prefix ? `↳ ${i.title}\n\n${i.body}` : i.body) : `${header}\n\n${i.body}`;
  if (answered && i.prUrl) text += `\n\n${i.prUrl}`;
  return text;
}

/** The text of a question as posted to a chat: the question, numbered options, and how to answer. */
export function questionText(q: Pick<AgentQuestion, 'question' | 'options' | 'multiple' | 'allowText'>): string {
  const lines = [`❓ ${q.question}`];
  if (q.options.length) lines.push('', ...q.options.map((o, i) => `${i + 1}) ${o}`));
  lines.push(
    '',
    q.multiple
      ? `☑️ Tick one or more, then press Done${q.allowText ? ' — or reply with numbers ("1, 3") or your own answer.' : ' (or reply with numbers, e.g. "1, 3").'}`
      : q.allowText || !q.options.length
        ? '✍️ Tap a button or just reply with your own answer.'
        : 'Tap a button (or reply with its number).',
  );
  return lines.join('\n');
}

/** The keyboard of a question: one button per option (a multiple-choice one shows ticks and a Done button). */
export function questionButtons(q: Pick<AgentQuestion, 'id' | 'options' | 'multiple'>, picked: ReadonlySet<number>): MessageButton[][] {
  const buttons = q.options.map((o, i) => ({
    label: q.multiple ? `${picked.has(i) ? '☑' : '☐'} ${i + 1}. ${o}` : `${i + 1}. ${o}`,
    data: q.multiple ? `qt:${q.id}:${i}` : `qa:${q.id}:${i}`,
  }));
  const rows = buttons.reduce<MessageButton[][]>((acc, b) => {
    const last = acc[acc.length - 1];
    if (!q.multiple && last && last.length < 2 && last[0]!.label.length + b.label.length < 36) last.push(b);
    else acc.push([b]);
    return acc;
  }, []);
  if (q.multiple) rows.push([{ label: `✅ Done${picked.size ? ` (${picked.size})` : ''}`, data: `qd:${q.id}` }]);
  return rows;
}

/** How a question ended, written over its chat message (the buttons go away). */
export function questionOutcome(q: Pick<AgentQuestion, 'question' | 'status' | 'answer' | 'answeredBy'>): string {
  if (q.status === 'answered') return `✅ ${q.question}\n→ ${q.answer}${q.answeredBy ? ` (${q.answeredBy.replace(/^[a-z]+:/, '')})` : ''}`;
  if (q.status === 'timeout') return `⌛ ${q.question}\n(no answer — the agent decided on its own)`;
  return `ℹ️ ${q.question}\n(withdrawn)`;
}

/** How an approval ended, written over its chat message. */
export function approvalOutcome(status: string): string {
  const icon = status === 'approved' ? '✅' : status === 'denied' ? '⛔' : 'ℹ️';
  return `${icon} Approval ${status}.`;
}
