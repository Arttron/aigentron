import { describe, expect, it } from 'vitest';
import { parseModelPage } from './model-list';

describe('parseModelPage', () => {
  it('reads an Anthropic page and its cursor', () => {
    expect(parseModelPage({ data: [{ id: 'a' }, { id: 'b' }], has_more: true, last_id: 'b' })).toEqual({ ids: ['a', 'b'], next: 'b' });
    expect(parseModelPage({ data: [{ id: 'c' }], has_more: false, last_id: 'c' })).toEqual({ ids: ['c'], next: null });
  });
  it('reads OpenAI-style and bare lists without a cursor', () => {
    expect(parseModelPage({ data: [{ id: 'gpt' }] })).toEqual({ ids: ['gpt'], next: null });
    expect(parseModelPage(['x', 'y'])).toEqual({ ids: ['x', 'y'], next: null });
    expect(parseModelPage(null)).toEqual({ ids: [], next: null });
  });
});
