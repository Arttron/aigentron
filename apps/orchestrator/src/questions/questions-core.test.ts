import { describe, expect, it } from 'vitest';
import { answerForModel, cleanQuestion, resolveAnswer } from './questions-core';

describe('cleanQuestion', () => {
  it('trims, de-duplicates and bounds the options', () => {
    const q = cleanQuestion({ question: '  Which one?  ', options: ['A', ' a ', 'B', '', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] });
    expect(q?.question).toBe('Which one?');
    expect(q?.options).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  });
  it('has nothing to ask without a question', () => {
    expect(cleanQuestion({ question: '  ' })).toBeNull();
    expect(cleanQuestion({ options: ['x'] })).toBeNull();
  });
});

describe('resolveAnswer', () => {
  const opts = ['Yes', 'No', 'Later'];
  it('takes a tapped button', () => {
    expect(resolveAnswer(opts, true, { index: 1 })).toEqual({ answer: 'No', index: 1 });
    expect(resolveAnswer(opts, true, { index: 7 })).toEqual({ error: 'There is no such answer option.' });
  });
  it('understands a number or the option text typed in a chat', () => {
    expect(resolveAnswer(opts, true, { text: '3' })).toEqual({ answer: 'Later', index: 2 });
    expect(resolveAnswer(opts, true, { text: '2.' })).toEqual({ answer: 'No', index: 1 });
    expect(resolveAnswer(opts, true, { text: 'yes' })).toEqual({ answer: 'Yes', index: 0 });
  });
  it('accepts free text only when allowed', () => {
    expect(resolveAnswer(opts, true, { text: 'Maybe tomorrow' })).toEqual({ answer: 'Maybe tomorrow', index: null });
    expect('error' in resolveAnswer(opts, false, { text: 'Maybe tomorrow' })).toBe(true);
    expect(resolveAnswer([], false, { text: 'free' })).toEqual({ answer: 'free', index: null });
    expect('error' in resolveAnswer(opts, true, { text: '  ' })).toBe(true);
  });
});

describe('answerForModel', () => {
  it('says what was answered, or why there is no answer', () => {
    expect(answerForModel({ status: 'answered', answer: 'No', answerIndex: 1 }, 60)).toBe('The user answered (option 2): No');
    expect(answerForModel({ status: 'answered', answer: 'text', answerIndex: null }, 60)).toBe('The user answered: text');
    expect(answerForModel({ status: 'timeout', answer: null, answerIndex: null }, 60)).toContain('Nobody answered within 60 min');
    expect(answerForModel({ status: 'cancelled', answer: null, answerIndex: null }, 60)).toContain('cancelled');
  });
});

describe('several options (multiple)', () => {
  const opts = ['Grammar', 'Vocabulary', 'Speaking', 'Writing'];
  it('joins ticked options in order', () => {
    expect(resolveAnswer(opts, true, { indexes: [2, 0] }, true)).toEqual({ answer: 'Grammar; Speaking', index: null });
    expect('error' in resolveAnswer(opts, true, { indexes: [] }, true)).toBe(true);
    expect('error' in resolveAnswer(opts, true, { indexes: [9] }, true)).toBe(true);
  });
  it('understands typed numbers and names', () => {
    expect(resolveAnswer(opts, false, { text: '1, 3' }, true)).toEqual({ answer: 'Grammar; Speaking', index: null });
    expect(resolveAnswer(opts, false, { text: '2 и 4' }, true)).toEqual({ answer: 'Vocabulary; Writing', index: null });
    expect(resolveAnswer(opts, false, { text: 'writing, grammar' }, true)).toEqual({ answer: 'Grammar; Writing', index: null });
    expect(resolveAnswer(opts, true, { text: 'all of them' }, true)).toEqual({ answer: 'all of them', index: null });
    expect('error' in resolveAnswer(opts, false, { text: 'all of them' }, true)).toBe(true);
  });
});
