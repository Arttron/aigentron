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
  return items;
}
