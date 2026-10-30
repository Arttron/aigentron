import { describe, expect, it } from 'vitest';
import { buildItems, type LogLine } from './transcript-items';

const l = (id: string, kind: string): LogLine => ({ id, kind, text: id });

describe('buildItems', () => {
  it('maps message kinds', () => {
    const items = buildItems([l('1', 'prompt'), l('2', 'assistant'), l('3', 'discussion'), l('4', 'result'), l('5', 'status')]);
    expect(items.map((i) => i.type)).toEqual(['user', 'agent', 'agent', 'agent', 'note']);
    expect(items.map((i) => (i.type === 'agent' ? i.final : null))).toEqual([null, false, false, true, null]);
  });
  it('folds a tool call and the result right after it into one row', () => {
    const items = buildItems([l('u', 'tool_use'), l('r', 'tool_result'), l('a', 'assistant')]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: 'tool', use: { id: 'u' }, result: { id: 'r' } });
  });
  it('keeps a lone call or a lone result as its own row', () => {
    const items = buildItems([l('u', 'tool_use'), l('x', 'assistant'), l('r', 'tool_result')]);
    expect(items[0]).toMatchObject({ type: 'tool', use: { id: 'u' }, result: null });
    expect(items[2]).toMatchObject({ type: 'tool', use: null, result: { id: 'r' } });
  });
  it('a subtask report is a message from that agent, not from the person', () => {
    const items = buildItems([{ id: 'r', kind: 'subtask_report', text: '**Design** · done', speaker: 'designer' }]);
    expect(items).toEqual([{ type: 'agent', line: expect.objectContaining({ speaker: 'designer' }), final: false }]);
  });
  it('is empty for no lines', () => expect(buildItems([])).toEqual([]));
});

describe('the answer repeated in front of a short closing line', () => {
  const long = 'The letter: '.padEnd(500, 'x');
  const line = (id: string, kind: string, text: string) => ({ id, kind, text }) as never;
  it('shows the text once', () => {
    const items = buildItems([line('1', 'prompt', 'q'), line('2', 'assistant', long), line('3', 'result', `${long}\n\nAnswered above.`)]);
    expect(items.map((i) => i.type)).toEqual(['user', 'agent']);
  });
  it('keeps both when the final one is a different text', () => {
    const items = buildItems([line('1', 'prompt', 'q'), line('2', 'assistant', long), line('3', 'result', 'Done.')]);
    expect(items).toHaveLength(3);
  });
});
