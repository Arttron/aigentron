import { describe, expect, it } from 'vitest';
import { withAttachments } from './real-agent-executor';

describe('withAttachments — the files of a subtask\'s lead are listed, marked read-only', () => {
  it('lists the own files and the lead\'s, saying which are the lead\'s and what they were uploaded as', () => {
    const own = '/data/attachments/sub1/notes.txt';
    const lead = '/data/attachments/lead1/a1b2-resume.md';
    const text = withAttachments('Find the candidate in the resume', [own, lead], { 'a1b2-resume.md': 'Artem-Romanov.md' }, new Set([lead]));
    expect(text).toContain('Find the candidate in the resume');
    expect(text).toContain(`- ${own}\n`);
    expect(text).toContain(`- ${lead}  (uploaded as «Artem-Romanov.md»)  (attached to the lead task — read only)`);
  });
  it('a task without a lead lists its files as before', () => {
    const t = withAttachments('x', ['/a/b.png'], {});
    expect(t).toContain('- /a/b.png');
    expect(t).not.toContain('lead task');
  });
});
