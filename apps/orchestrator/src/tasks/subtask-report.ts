/**
 * What a lead is told when its subtasks report back, in a form the transcript can take apart again: one block per subtask, each headed by
 * `### «title» (subtask <id>) → <status>`. The model reads the whole text; the conversation shows each block as a message FROM the subtask's agent
 * (not as "you>"), and drops the instruction paragraphs. Pure.
 */

export const FAN_IN_TAIL_MARK = 'Review their results and continue';
export const ESCALATION_TAIL_MARK = 'Handle it now';

export function subtaskBlock(i: { id: string; title: string; status: string; body: string }): string {
  return `### «${i.title.replace(/\n/g, ' ')}» (subtask ${i.id}) → ${i.status}\n${i.body.trim()}`;
}

export interface SubtaskReport {
  id: string;
  title: string;
  status: string;
  text: string;
}

const HEADER = /^### «(.*)» \(subtask ([\w-]{6,40})\) → (\w+)[ \t]*$/gm;

/**
 * The blocks of a lead's "subtasks reported" prompt, or null when the text is not one. `rest` is whatever follows the instruction paragraph
 * (e.g. a person's message queued behind it) and still belongs in the conversation as the person's words.
 */
export function splitSubtaskReport(prompt: string): { reports: SubtaskReport[]; rest: string } | null {
  const marks = [...prompt.matchAll(HEADER)];
  if (!marks.length) return null;
  // the instruction paragraph ends the last block: from its mark to the end of that paragraph
  let tailAt = -1;
  let tailEnd = prompt.length;
  for (const m of [FAN_IN_TAIL_MARK, ESCALATION_TAIL_MARK]) {
    const at = prompt.lastIndexOf(`\n\n${m}`);
    if (at > marks[0]!.index! && (tailAt < 0 || at < tailAt)) tailAt = at;
  }
  let rest = '';
  if (tailAt >= 0) {
    const para = prompt.indexOf('\n\n', tailAt + 2);
    tailEnd = para < 0 ? prompt.length : para;
    rest = para < 0 ? '' : prompt.slice(para).trim();
  }
  const bodyEnd = tailAt >= 0 ? tailAt : tailEnd;
  const reports = marks.map((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : bodyEnd;
    return { id: m[2]!, title: m[1]!, status: m[3]!, text: prompt.slice(start, end).trim() };
  });
  return { reports, rest };
}
