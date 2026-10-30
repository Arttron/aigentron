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
