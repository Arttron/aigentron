import { describe, expect, it } from 'vitest';
import { BRIEF_TEMPLATE, buildDigest, formatNote, globToRegex, matchesGlob, memoryHeader, orientationBlock, resolveQuestion, safeRelative } from './workspace-core';

describe('workspace core', () => {
  it('formats notes as dated lines; questions start open', () => {
    const d = new Date('2026-10-12T09:05:00Z');
    expect(formatNote('decision', ' Use ESP32 \n', d)).toBe('- 2026-10-12 09:05Z — Use ESP32\n');
    expect(formatNote('question', 'Which battery?', d, 'pm')).toBe('- [ ] 2026-10-12 09:05Z (pm) — Which battery?\n');
    expect(formatNote('fact', 'a\n\nb', d)).toContain('a\n  b');
  });

  it('resolves the first open question matching the fragment', () => {
    const f = `${memoryHeader('question')}- [ ] 2026 — Which battery?\n- [ ] 2026 — Which battery size?\n`;
    const r = resolveQuestion(f, 'which BATTERY')!;
    expect(r).toContain('- [x] 2026 — Which battery?');
    expect(r).toContain('- [ ] 2026 — Which battery size?');
    expect(resolveQuestion(f, 'nothing like it')).toBeNull();
    expect(resolveQuestion(f, '  ')).toBeNull();
  });

  it('accepts only clean relative paths', () => {
    expect(safeRelative('reports/summary.md')).toBe('reports/summary.md');
    expect(safeRelative('./a//b.txt')).toBe('a/b.txt');
    expect(safeRelative('отчёт/итог.md')).toBe('отчёт/итог.md');
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', '.versions/x', 'a/.hidden', 'C:\\x', 'a\0b']) expect(safeRelative(bad), bad).toBeNull();
  });

  it('globs', () => {
    expect(globToRegex('*.md').test('a.md')).toBe(true);
    expect(globToRegex('*.md').test('d/a.md')).toBe(false);
    expect(globToRegex('**/*.md').test('d/e/a.md')).toBe(true);
    expect(globToRegex('a?.txt').test('ab.txt')).toBe(true);
    expect(globToRegex('a.txt').test('abtxt')).toBe(false);
  });

  it('a glob without a slash matches names at any depth', () => {
    expect(matchesGlob('*.md', 'notes/a.md')).toBe(true);
    expect(matchesGlob('*', 'a/b/c.txt')).toBe(true);
    expect(matchesGlob('notes/*.md', 'notes/a.md')).toBe(true);
    expect(matchesGlob('notes/*.md', 'other/a.md')).toBe(false);
  });

  it('digest skips untouched files and keeps the latest', () => {
    const empty = { brief: BRIEF_TEMPLATE, status: memoryHeader('status'), decisions: memoryHeader('decision'), questions: memoryHeader('question') };
    expect(buildDigest(empty)).toBe('');
    const decisions = memoryHeader('decision') + Array.from({ length: 20 }, (_, i) => `- d${i}\n`).join('');
    const out = buildDigest({ ...empty, brief: '# Brief\nGoal: a wearable', decisions, questions: '- [ ] q1\n- [x] q2\n' });
    expect(out).toContain('Goal: a wearable');
    expect(out).toContain('- d19');
    expect(out).not.toContain('- d4\n');
    expect(out).toContain('- [ ] q1');
    expect(out).not.toContain('q2');
    expect(out.length).toBeLessThan(7000);
  });

  it('orientation names the folders and the tools', () => {
    const o = orientationBlock('/data/workspace');
    for (const s of ['/data/workspace', 'work/', 'deliverables/', 'memory/', 'workspace_save', 'workspace_note']) expect(o).toContain(s);
  });
});
