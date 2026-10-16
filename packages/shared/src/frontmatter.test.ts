import { describe, expect, it } from 'vitest';
import { isListedMarkdown, parseFrontmatter } from './frontmatter';

describe('parseFrontmatter', () => {
  it('reads fields, lines and the body (CRLF, quotes, comments)', () => {
    const fm = parseFrontmatter('---\r\nname: x\r\n# c\r\ndescription: "Hello: world"\r\n---\r\nBody\r\n')!;
    expect(fm.fields).toEqual({ name: 'x', description: 'Hello: world' });
    expect(fm.body).toBe('Body\r\n');
    expect(fm.lines).toContain('# c');
  });
  it('returns null without frontmatter', () => {
    expect(parseFrontmatter('# Title\ntext')).toBeNull();
  });
  it('isListedMarkdown skips READMEs and non-md', () => {
    expect(isListedMarkdown('a/b/skill.md')).toBe(true);
    expect(isListedMarkdown('core/README.md')).toBe(false);
    expect(isListedMarkdown('x.txt')).toBe(false);
  });
});
