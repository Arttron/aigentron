import { describe, expect, it } from 'vitest';
import { LATER_WINS, SCHEDULED_RULE, escalationNote, lostSessionNote, standingInstructions } from './session-continuity';

describe('what a model that takes over a conversation is told', () => {
  it('a lost session: the original request, the history, and that a later message wins', () => {
    const n = lostSessionNote('search for cats', 'Person: search for dogs instead');
    expect(n).toContain('original request: search for cats');
    expect(n).toContain('Person: search for dogs instead');
    expect(n).toContain(LATER_WINS);
    expect(n.indexOf(LATER_WINS)).toBeGreaterThan(n.indexOf('Person: search for dogs'));
  });
  it('an escalation says it too, and cuts a huge request', () => {
    expect(escalationNote('x'.repeat(10_000)).length).toBeLessThan(3400);
    expect(escalationNote('a')).toContain(LATER_WINS);
  });
});

describe('standingInstructions (a scheduled task: what the person asked for the next runs)', () => {
  const SCHEDULE = 'Search the news for: cats, dogs. Report the top 5.';
  it('the person\'s message in the conversation is found, though the schedule\'s text came after it', () => {
    const texts = [SCHEDULE, SCHEDULE, 'From now on also search for: birds, and skip anything older than a week', SCHEDULE, SCHEDULE];
    const s = standingInstructions(texts, SCHEDULE);
    expect(s).toContain('also search for: birds');
    expect(s).toContain('win over the schedule');
    expect(s).not.toContain('Search the news for: cats');
  });
  it('nothing when only the schedule has spoken, or the person only said thanks; the first message and the run\'s own are the schedule\'s', () => {
    expect(standingInstructions([SCHEDULE, SCHEDULE, SCHEDULE], SCHEDULE)).toBe('');
    expect(standingInstructions([SCHEDULE, 'thanks!', SCHEDULE], SCHEDULE)).toBe('');
    // the schedule's text was edited: the new text is the run's own message, the old one was repeated
    expect(standingInstructions(['old text of the schedule here', 'old text of the schedule here', 'NEW text of the schedule here'], 'NEW text of the schedule here')).toBe('');
  });
  it('keeps the latest few, each cut', () => {
    const many = [SCHEDULE, ...Array.from({ length: 12 }, (_, i) => `Adjustment number ${i} to the search for next runs`)];
    const s = standingInstructions(many, SCHEDULE);
    expect(s).not.toContain('number 0 ');
    expect(s).toContain('number 11 ');
    expect(s.split('\n- ').length - 1).toBe(8);
    expect(standingInstructions([SCHEDULE, `${'x'.repeat(2000)} long`], SCHEDULE).length).toBeLessThan(900);
  });
  it('the lost-session note for a scheduled task says the person\'s messages win over the schedule\'s text', () => {
    expect(lostSessionNote('a', 'b', true)).toContain(SCHEDULED_RULE);
    expect(lostSessionNote('a', 'b', false)).toContain(LATER_WINS);
  });
});
