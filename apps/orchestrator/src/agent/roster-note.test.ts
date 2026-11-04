import { describe, expect, it } from 'vitest';
import { newColleaguesNote } from './roster-note';

const seo = { name: 'seo', how: 'create_subtask {agent:"seo"} only (a different runtime)' };
const dev = { name: 'dev', how: 'Task tool, subagent_type "dev" (or create_subtask)' };

describe('newColleaguesNote', () => {
  it('says nothing on the first run (no earlier roster) or when nothing changed', () => {
    expect(newColleaguesNote(undefined, [seo, dev])).toBe('');
    expect(newColleaguesNote(['seo', 'dev'], [seo, dev])).toBe('');
  });
  it('names who joined since the last run and how to reach each', () => {
    const note = newColleaguesNote(['dev'], [dev, seo]);
    expect(note).toContain('New colleagues since your last run: seo (create_subtask {agent:"seo"} only');
    expect(note).not.toContain('dev (');
  });
  it('a colleague that left is not mentioned', () => {
    expect(newColleaguesNote(['dev', 'seo'], [dev])).toBe('');
  });
});
