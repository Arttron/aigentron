import { describe, expect, it } from 'vitest';
import { NO_WORDS, eventSearchText, fts5Query, groupHits, hasPhrases, hitScore, matchRanges, parseQuery, snippetOf, type EventHit } from './search-core';

describe('eventSearchText', () => {
  it('keeps the stemmed words of a message, once each', () => {
    expect(eventSearchText('result', 'Литве бонусы, бонусы в Литве').split(' ').sort()).toEqual(['бону', 'литв'].sort());
  });
  it('a kind that is not a conversation is not indexed; a message of only short words is marked, not empty', () => {
    expect(eventSearchText('tool_use', 'ls -la')).toBe('');
    expect(eventSearchText('prompt', 'a я')).toBe(NO_WORDS);
  });
  it('very long text is cut', () => {
    expect(eventSearchText('assistant', 'word '.repeat(50_000))).toBe('word');
  });
});

describe('parseQuery', () => {
  it('plain words, a phrase and an exclusion', () => {
    const q = parseQuery('литва "налоговый бонус" -грант');
    expect(q.phrases).toEqual(['налоговый бонус']);
    expect(q.excluded).toEqual(['гран']);
    expect(q.terms).toEqual(expect.arrayContaining(['литв', 'нало', 'бону']));
  });
  it('a hyphen inside a word is not an exclusion', () => {
    expect(parseQuery('e-mail').excluded).toEqual([]);
  });
  it('a query of only stop words has no terms', () => {
    expect(parseQuery('the a').terms).toEqual([]);
  });
});

describe('phrases and marks', () => {
  it('a phrase must be in the text as written (case and spaces aside)', () => {
    expect(hasPhrases('Налоговый   БОНУС для новой', ['налоговый бонус'])).toBe(true);
    expect(hasPhrases('бонус налоговый', ['налоговый бонус'])).toBe(false);
  });
  it('marks every form of a query word', () => {
    const t = 'В Литве и Литвы бонусы';
    const m = matchRanges(t, parseQuery('литва').terms).map(([a, b]) => t.slice(a, b));
    expect(m).toEqual(['Литве', 'Литвы']);
  });
});

describe('snippetOf', () => {
  it('a short text is whole', () => {
    const s = snippetOf('hello brave world', parseQuery('brave').terms);
    expect(s.text).toBe('hello brave world');
    expect(s.marks.map(([a, b]) => s.text.slice(a, b))).toEqual(['brave']);
  });
  it('a long text is cut around the first match, with the marks moved with it', () => {
    const long = `${'start '.repeat(80)}needle ${'end '.repeat(80)}`;
    const s = snippetOf(long, parseQuery('needle').terms);
    expect(s.text.length).toBeLessThan(260);
    expect(s.text.startsWith('… ')).toBe(true);
    expect(s.marks.map(([a, b]) => s.text.slice(a, b))).toEqual(['needle']);
  });
});

describe('ranking', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const day = 86_400_000;
  const hit = (over: Partial<EventHit>): EventHit => ({ eventId: 'e', line: 's:1', taskId: 't', kind: 'result', speaker: null, at: new Date(now), rank: 1, snippet: { text: over.eventId ?? 'e', marks: [] }, ...over });
  it('newer beats older, a person\'s message beats an agent\'s', () => {
    expect(hitScore(hit({}), now)).toBeGreaterThan(hitScore(hit({ at: new Date(now - 200 * day) }), now));
    expect(hitScore(hit({ kind: 'prompt' }), now)).toBeGreaterThan(hitScore(hit({}), now));
  });
  it('the same words said twice in a task (an agent message and its result) are shown once', () => {
    const same = { text: 'Hello! How can I help?', marks: [] as [number, number][] };
    const g = groupHits([hit({ eventId: 'x1', kind: 'assistant', snippet: same }), hit({ eventId: 'x2', kind: 'result', rank: 2, snippet: same }), hit({ eventId: 'x3', snippet: { text: 'other', marks: [] } })], now);
    expect(g[0]!.hits.map((h) => h.eventId)).toEqual(['x2', 'x3']);
  });
  it('groups by task: best task first, at most 3 hits each, best hit first', () => {
    const hits = [
      hit({ eventId: 'a1', taskId: 'A', rank: 0.2 }),
      hit({ eventId: 'b1', taskId: 'B', rank: 0.9 }),
      hit({ eventId: 'a2', taskId: 'A', rank: 0.3 }),
      hit({ eventId: 'a3', taskId: 'A', rank: 0.25 }),
      hit({ eventId: 'a4', taskId: 'A', rank: 0.1 }),
    ];
    const g = groupHits(hits, now);
    expect(g.map((x) => x.taskId)).toEqual(['B', 'A']);
    expect(g[1]!.hits.map((h) => h.eventId)).toEqual(['a2', 'a3', 'a1']);
  });
});

describe('fts5Query', () => {
  it('quotes every word and excludes with NOT', () => {
    expect(fts5Query(['a', 'b'], ['c'])).toBe('"a" "b" NOT "c"');
    expect(fts5Query(['a"b'], [])).toBe('"a""b"');
  });
});
