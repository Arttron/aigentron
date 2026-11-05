import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS modules of the extension
import { ago, sortTasks, statusChip, toMessages } from './transcript.js';
// @ts-expect-error plain JS modules of the extension
import { blocks } from './md.js';

describe('the conversation of a task', () => {
  const ev = (kind: string, text: string, extra: object = {}) => ({ kind, text, seq: 1, createdAt: '2026-01-01T10:00:00Z', ...extra });
  it('keeps what somebody said and drops tool steps, system lines and empty text', () => {
    const m = toMessages([ev('prompt', 'Fix it'), ev('system', 'agent started'), ev('tool_use', 'Bash ls'), ev('assistant', 'On it'), ev('assistant', '   '), ev('result', 'Done: fixed', { seq: 9 })]);
    expect(m.map((x: { role: string; text: string }) => [x.role, x.text])).toEqual([['you', 'Fix it'], ['agent', 'On it'], ['result', 'Done: fixed']]);
  });
  it('a long message the final answer begins with is shown once', () => {
    const long = 'The letter: '.padEnd(500, 'x');
    const m = toMessages([ev('assistant', long), ev('result', `${long}\n\nAnswered above.`, { seq: 2 })]);
    expect(m).toHaveLength(1);
    expect(m[0].role).toBe('result');
    // a short earlier message stays
    expect(toMessages([ev('assistant', 'short'), ev('result', 'short\n\nok', { seq: 2 })])).toHaveLength(2);
  });
  it('the same event twice (history + live) is one message; a speaker is kept', () => {
    const e = ev('discussion', 'My view', { speaker: 'architect' });
    const m = toMessages([e, { ...e }]);
    expect(m).toHaveLength(1);
    expect(m[0].speaker).toBe('architect');
  });
});

describe('statuses, time, order', () => {
  it('labels', () => {
    expect(statusChip('needs_approval')).toEqual({ label: 'waiting for you', tone: 'amber' });
    expect(statusChip('review').label).toBe('ready — confirm');
    expect(statusChip('weird').label).toBe('weird');
  });
  it('relative time', () => {
    const now = Date.parse('2026-01-02T12:00:00Z');
    expect(ago('2026-01-02T11:59:50Z', now)).toBe('just now');
    expect(ago('2026-01-02T11:30:00Z', now)).toBe('30 min ago');
    expect(ago('2026-01-02T08:00:00Z', now)).toBe('4 h ago');
    expect(ago('2026-01-01T08:00:00Z', now)).toBe('yesterday');
    expect(ago('2025-12-20T08:00:00Z', now)).toBe('13 days ago');
    expect(ago('nope', now)).toBe('');
  });
  it('what needs the person comes first, then running, then the rest by recency', () => {
    const order = sortTasks([
      { id: 'a', status: 'done', updatedAt: '2026-01-03' },
      { id: 'b', status: 'running', updatedAt: '2026-01-01' },
      { id: 'c', status: 'needs_approval', updatedAt: '2026-01-01' },
      { id: 'd', status: 'done', updatedAt: '2026-01-04' },
    ]).map((t: { id: string }) => t.id);
    expect(order).toEqual(['c', 'b', 'd', 'a']);
  });
});

describe('markdown blocks (the safe renderer builds nodes from these)', () => {
  it('paragraphs, code, lists, headings', () => {
    expect(blocks('Hello\nworld\n\n- a\n- b\n\n```js\nlet x = 1;\n```\n\n## Title')).toEqual([
      { type: 'p', text: 'Hello\nworld' },
      { type: 'list', items: ['a', 'b'] },
      { type: 'code', text: 'let x = 1;' },
      { type: 'heading', text: 'Title' },
    ]);
    expect(blocks('')).toEqual([]);
    expect(blocks('1. one\n2) two')).toEqual([{ type: 'list', items: ['one', 'two'] }]);
  });
});

describe('the same message told twice', () => {
  it('has the same content key whatever ids the socket and the transcript give it (the panel shows it once)', () => {
    const live = toMessages([{ id: 'live:prompt:7', kind: 'prompt', seq: 7, text: 'Please also add a test' }]);
    const stored = toMessages([{ id: 'cmw2abcdef', kind: 'prompt', seq: 7, text: 'Please also add a test' }]);
    expect(live[0].id).not.toBe(stored[0].id);
    expect(live[0].ck).toBe(stored[0].ck);
  });
});

