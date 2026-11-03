import { describe, expect, it } from 'vitest';
import { finalWithAnswer, isQuietTool } from './final-answer';

const LONG = 'Letter to ENTSO-E: '.padEnd(500, 'x');

describe('finalWithAnswer', () => {
  it('puts the long message in front of a short «answered above»', () => {
    expect(finalWithAnswer(LONG, 'Ответил выше.')).toBe(`${LONG}\n\nОтветил выше.`);
  });
  it('leaves a real final answer, an already included answer and a run with no long message alone', () => {
    const real = 'x'.repeat(300);
    expect(finalWithAnswer(LONG, real)).toBe(real);
    expect(finalWithAnswer(LONG, `${LONG}\n\nok`)).toBe(`${LONG}\n\nok`);
    expect(finalWithAnswer('', 'Готово.')).toBe('Готово.');
  });
  it('knows the tools that do not end «the answer»', () => {
    expect(isQuietTool('mcp__lds_internal__report_task_status')).toBe(true);
    expect(isQuietTool('Bash')).toBe(false);
  });
});

import { AnswerTracker } from './final-answer';

describe('AnswerTracker', () => {
  it('puts the long message in front of the closing of the first result', () => {
    const t = new AnswerTracker();
    t.assistant(LONG);
    expect(t.result('Done.')).toBe(`${LONG}\n\nDone.`);
  });
  it('a reporting-resume turn after it does not carry the answer a second time', () => {
    const t = new AnswerTracker();
    t.assistant(LONG);
    t.result('Ответил выше.'); // the main run's result
    t.tool('mcp__lds_internal__report_task_status'); // the resume turn reports…
    expect(t.result('Status reported.')).toBe('Status reported.'); // …and ends with its own short result, not the old answer again
  });
  it('real work after the message makes it a stage, not the answer', () => {
    const t = new AnswerTracker();
    t.assistant(LONG);
    t.tool('Bash');
    expect(t.result('Done.')).toBe('Done.');
  });
  it('a quiet tool (the report) does not take the answer away', () => {
    const t = new AnswerTracker();
    t.assistant(LONG);
    t.tool('mcp__lds_internal__report_task_status');
    expect(t.result('Done.')).toBe(`${LONG}\n\nDone.`);
  });
});

import { resumeTurnEvent } from './final-answer';
describe('resumeTurnEvent', () => {
  it('the reply of the reporting-resume turn is a note, never the task\'s newest result', () => {
    expect(resumeTurnEvent({ kind: 'result', text: 'Status reported.' })).toEqual({ kind: 'stderr', text: '↻ Status reported.' });
    expect(resumeTurnEvent({ kind: 'result', text: '' })).toEqual({ kind: 'stderr', text: '↻ outcome recorded' });
  });
  it('every other event passes unchanged', () => {
    const a = { kind: 'assistant', text: 'hi' };
    expect(resumeTurnEvent(a)).toBe(a);
  });
});

import { noToolsNote } from './final-answer';
describe('noToolsNote', () => {
  it('warns for a scheduled run that used no tool, and only then', () => {
    expect(noToolsNote(0, true, false)).toMatch(/not based on fresh data/);
    expect(noToolsNote(1, true, false)).toBe('');
    expect(noToolsNote(0, false, false)).toBe(''); // a person asked: text only is fine
    expect(noToolsNote(0, true, true)).toBe(''); // a chat turn
  });
});
