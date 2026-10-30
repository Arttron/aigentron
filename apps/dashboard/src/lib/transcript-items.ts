export interface LogLine {
  id: string;
  kind: string;
  text: string;
  attachments?: string[];
  /** who said it — a message in a discussion between agents, or a subtask's report in its lead's conversation */
  speaker?: string;
  ts?: string;
}

export type Item =
  | { type: 'user'; line: LogLine }
  | { type: 'agent'; line: LogLine; final: boolean }
  | { type: 'tool'; use: LogLine | null; result: LogLine | null }
  | { type: 'note'; line: LogLine };

/** Folds the flat event list into chat items: a tool call and its result become ONE collapsible row. */
export function buildItems(lines: LogLine[]): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.kind === 'prompt') items.push({ type: 'user', line: l });
    else if (l.kind === 'assistant') items.push({ type: 'agent', line: l, final: false });
    else if (l.kind === 'discussion' || l.kind === 'subtask_report') items.push({ type: 'agent', line: l, final: false });
    else if (l.kind === 'result') items.push({ type: 'agent', line: l, final: true });
    else if (l.kind === 'tool_use') {
      const next = lines[i + 1];
      if (next?.kind === 'tool_result') {
        items.push({ type: 'tool', use: l, result: next });
        i++;
      } else items.push({ type: 'tool', use: l, result: null });
    } else if (l.kind === 'tool_result') items.push({ type: 'tool', use: null, result: l });
    else items.push({ type: 'note', line: l });
  }
  return dropRepeatedAnswer(items);
}

/**
 * The server puts the long message an agent wrote just before a short closing line («answered above») in front of that line, so the final
 * answer stands on its own (Telegram, «messages only»). Here the earlier copy is dropped so the conversation does not show the text twice.
 */
function dropRepeatedAnswer(items: Item[]): Item[] {
  const drop = new Set<number>();
  items.forEach((it, i) => {
    if (it.type !== 'agent' || !it.final) return;
    const answer = it.line.text.trim();
    for (let j = i - 1; j >= 0; j--) {
      const prev = items[j]!;
      if (prev.type === 'user') break;
      if (prev.type === 'agent' && !prev.final && prev.line.kind === 'assistant') {
        const t = prev.line.text.trim();
        if (t.length >= 400 && answer.startsWith(t)) drop.add(j);
        break;
      }
    }
  });
  return drop.size ? items.filter((_, i) => !drop.has(i)) : items;
}
