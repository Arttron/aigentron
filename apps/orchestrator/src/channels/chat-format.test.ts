import { describe, expect, it } from 'vitest';
import { approvalOutcome, compactProcessLine, questionButtons, questionOutcome, questionText, reactionIcon, resultMessage, withQuote } from './chat-format';

describe('chat-format', () => {
  it('reactionIcon: one icon per outcome', () => {
    expect(reactionIcon('review')).toBe('✅');
    expect(reactionIcon('done')).toBe('✅');
    expect(reactionIcon('blocked')).toBe('⛔');
    expect(reactionIcon('cancelled')).toBe('🛑');
    expect(reactionIcon('failed')).toBe('❌');
    expect(reactionIcon('stalled')).toBe('❌');
  });

  it('compactProcessLine: short narrated kinds only, clipped at ~100 chars', () => {
    expect(compactProcessLine('tool_use', 'Bash ls -la')).toBe('🔧 Bash ls -la');
    expect(compactProcessLine('delegation', 'to dev')).toBe('🤝 to dev');
    expect(compactProcessLine('assistant', 'thinking')).toBe('💭 thinking');
    expect(compactProcessLine('stderr', 'boom')).toBe('⚠️ boom');
    expect(compactProcessLine('tool_result', 'x'.repeat(5000))).toBeNull();
    expect(compactProcessLine('result', 'final')).toBeNull();
    const long = compactProcessLine('tool_use', 'a'.repeat(200))!;
    expect(long.length).toBe(100);
    expect(long.endsWith('…')).toBe(true);
  });

  it('withQuote puts the quoted words in front, trimmed', () => {
    expect(withQuote('ok, do it')).toBe('ok, do it');
    expect(withQuote('ok, do it', '  ')).toBe('ok, do it');
    expect(withQuote('ok, do it', 'Shall I   deploy?')).toBe('↩︎ Replying to «Shall I deploy?»\n\nok, do it');
    expect(withQuote('x', 'a'.repeat(600))).toContain('…»');
  });

  describe('resultMessage', () => {
    it('a finished top-level task is just the answer (header only with /progress on)', () => {
      expect(resultMessage({ status: 'review', title: 'T', body: 'the answer', prefix: '', progress: false })).toBe('the answer');
      expect(resultMessage({ status: 'review', title: 'T', body: 'the answer', prefix: '', progress: true })).toBe('✅ «T»\n\nthe answer');
      expect(resultMessage({ status: 'review', title: 'T', body: 'b', prefix: '', prUrl: 'https://pr', progress: false })).toBe('b\n\nhttps://pr');
    });
    it("a subtask's answer in the parent chat says which subtask it is", () => {
      expect(resultMessage({ status: 'done', title: 'Sub', body: 'ok', prefix: '↳ Subtask ', progress: false })).toBe('↳ Sub\n\nok');
      expect(resultMessage({ status: 'done', title: 'Sub', body: 'ok', prefix: '↳ Subtask ', progress: true })).toBe('↳ Subtask ✅ «Sub»\n\nok');
    });
    it('a task that needs attention always carries the header with its status', () => {
      expect(resultMessage({ status: 'blocked', title: 'T', body: 'why', prefix: '', progress: false })).toBe('⛔ «T» — blocked\n\nwhy');
      expect(resultMessage({ status: 'failed', title: 'T', body: 'err', prefix: '', prUrl: 'https://pr', progress: false })).toBe('❌ «T» — failed\n\nerr');
    });
  });

  describe('questions', () => {
    const base = { id: 'q1', question: 'Deploy?', options: ['yes', 'no'], multiple: false, allowText: false };
    it('questionText lists the options and how to answer', () => {
      expect(questionText(base)).toBe('❓ Deploy?\n\n1) yes\n2) no\n\nTap a button (or reply with its number).');
      expect(questionText({ ...base, allowText: true })).toContain('✍️');
      expect(questionText({ ...base, options: [] })).toBe('❓ Deploy?\n\n✍️ Tap a button or just reply with your own answer.');
      expect(questionText({ ...base, multiple: true })).toContain('☑️ Tick one or more');
    });
    it('questionButtons: short single-choice options share a row; multiple choice shows ticks and Done', () => {
      expect(questionButtons(base, new Set())).toEqual([[{ label: '1. yes', data: 'qa:q1:0' }, { label: '2. no', data: 'qa:q1:1' }]]);
      const long = questionButtons({ ...base, options: ['a'.repeat(30), 'b'.repeat(30)] }, new Set());
      expect(long).toHaveLength(2);
      const multi = questionButtons({ ...base, multiple: true, options: ['a', 'b', 'c'] }, new Set([1]));
      expect(multi.map((r) => r.map((b) => b.label))).toEqual([['☐ 1. a'], ['☑ 2. b'], ['☐ 3. c'], ['✅ Done (1)']]);
      expect(multi[1]![0]!.data).toBe('qt:q1:1');
      expect(multi[3]![0]!.data).toBe('qd:q1');
    });
    it('questionOutcome / approvalOutcome', () => {
      expect(questionOutcome({ question: 'Q', status: 'answered', answer: 'yes', answeredBy: 'telegram:bob' })).toBe('✅ Q\n→ yes (bob)');
      expect(questionOutcome({ question: 'Q', status: 'timeout', answer: null, answeredBy: null })).toContain('⌛');
      expect(questionOutcome({ question: 'Q', status: 'cancelled', answer: null, answeredBy: null })).toContain('withdrawn');
      expect(approvalOutcome('approved')).toBe('✅ Approval approved.');
      expect(approvalOutcome('denied')).toBe('⛔ Approval denied.');
      expect(approvalOutcome('timeout')).toBe('ℹ️ Approval timeout.');
    });
  });
});
