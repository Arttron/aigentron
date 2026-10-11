import { describe, expect, it } from 'vitest';
import { AGREED_MARK, allAgreed, buildSummaryPrompt, buildTurnPrompt, cleanParticipants, cleanRounds, stripMark, trimTranscript } from './discussion-core';

describe('participants and rounds', () => {
  it('needs 2–6 distinct agents', () => {
    expect(cleanParticipants(['pm', 'PM', 'dev'])).toEqual({ agents: ['pm', 'dev'] });
    expect('error' in cleanParticipants(['pm'])).toBe(true);
    expect('error' in cleanParticipants(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe(true);
    expect('error' in cleanParticipants('x')).toBe(true);
  });
  it('rounds are bounded', () => {
    expect(cleanRounds(3)).toBe(3);
    expect(cleanRounds(0)).toBe(1);
    expect(cleanRounds(99)).toBe(8);
    expect(cleanRounds('x')).toBe(3);
  });
});

describe('prompts', () => {
  const turns = [{ speaker: 'pm', text: 'We should ship on Friday.' }, { speaker: 'Human', text: 'Why Friday?' }];
  it('shows the topic, the others, the conversation and the rules', () => {
    const p = buildTurnPrompt({ topic: 'Release date', speaker: 'dev', participants: ['pm', 'dev', 'qa'], turns, turnNumber: 3, totalTurns: 9, humanHint: true });
    expect(p).toContain('as "dev"');
    expect(p).toContain('pm, qa');
    expect(p).toContain('Release date');
    expect(p).toContain('pm: We should ship on Friday.');
    expect(p).toContain('Human: Why Friday?');
    expect(p).toContain('turn 3 of 9');
    expect(p).toContain(AGREED_MARK);
  });
  it('the opener sees an empty conversation; the summary lists everything', () => {
    expect(buildTurnPrompt({ topic: 't', speaker: 'pm', participants: ['pm', 'dev'], turns: [], turnNumber: 1, totalTurns: 4 })).toContain('you open the discussion');
    expect(buildSummaryPrompt({ topic: 't', speaker: 'pm', participants: ['pm', 'dev'], turns })).toContain('what was agreed');
  });
});

describe('transcript and agreement', () => {
  it('keeps the newest turns that fit', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ speaker: 'a', text: `${i} ${'x'.repeat(500)}` }));
    const t = trimTranscript(many, 3000);
    expect(t.shown.length).toBeLessThan(10);
    expect(t.shown[t.shown.length - 1]!.text.startsWith('39 ')).toBe(true);
    expect(t.omitted + t.shown.length).toBe(40);
  });
  it('stops only when a whole round ends with the mark', () => {
    const ok = (s: string) => ({ speaker: s, text: `fine ${AGREED_MARK}` });
    expect(allAgreed([ok('a'), ok('b')], ['a', 'b'])).toBe(true);
    expect(allAgreed([{ speaker: 'a', text: 'no' }, ok('b')], ['a', 'b'])).toBe(false);
    expect(allAgreed([ok('a')], ['a', 'b'])).toBe(false);
    expect(stripMark(`yes ${AGREED_MARK}`)).toBe('yes');
  });
});
