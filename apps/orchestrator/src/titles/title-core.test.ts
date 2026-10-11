import { describe, expect, it } from 'vitest';
import { buildTitleInput, cleanTitle, fallbackTitle, isWeakPrompt } from './title-core';

describe('fallbackTitle', () => {
  it('is the first line, cut at 80', () => {
    expect(fallbackTitle('Write a report\nwith details')).toBe('Write a report');
    expect(fallbackTitle('x'.repeat(100))).toHaveLength(78);
    expect(fallbackTitle('   ')).toBe('Untitled task');
  });
});

describe('isWeakPrompt', () => {
  it('flags requests that cannot name a task', () => {
    for (const p of ['Review the attached file(s).', 'hi', 'посмотри фото', 'Привет', 'test', 'это файл']) expect(isWeakPrompt(p)).toBe(true);
  });
  it('lets informative requests through', () => {
    for (const p of ['Сравни цены на датчик температуры у пяти поставщиков', 'What is the capital of France?', 'Fix the login redirect bug on the settings page']) expect(isWeakPrompt(p)).toBe(false);
  });
});

describe('buildTitleInput', () => {
  it('shows the request, attachments, agent and the start of the answer', () => {
    const s = buildTitleInput({ prompt: 'Look at this', attachments: ['wall.jpg', 'clip.mp4', 'spec.pdf'], agent: 'renovator', answer: 'The crack is structural.' });
    expect(s).toContain('wall.jpg (image)');
    expect(s).toContain('clip.mp4 (video)');
    expect(s).toContain('spec.pdf (PDF)');
    expect(s).toContain('renovator');
    expect(s).toContain('structural');
  });
});

describe('cleanTitle', () => {
  it('strips quotes, markdown, prefixes and the final period', () => {
    expect(cleanTitle('"Сравнение цен на датчики температуры."')).toBe('Сравнение цен на датчики температуры');
    expect(cleanTitle('**Title:** Fix login redirect')).toBe('Fix login redirect');
    expect(cleanTitle('Название: Ремонт кухни\nлишнее')).toBe('Ремонт кухни');
    expect(cleanTitle('«План проекта»')).toBe('План проекта');
  });
  it('cuts long titles at a word and rejects refusals and nonsense', () => {
    const t = cleanTitle('word '.repeat(40))!;
    expect(t.length).toBeLessThanOrEqual(70);
    expect(t.endsWith('…')).toBe(true);
    expect(cleanTitle("I'm sorry, I can't help with that")).toBeNull();
    expect(cleanTitle('  ')).toBeNull();
    expect(cleanTitle('ab')).toBeNull();
  });
});
