import { describe, expect, it } from 'vitest';
import { userBlocks } from './user-markdown';
import { parseMarkdown } from './markdown-parse';

describe('userBlocks', () => {
  it('a message with no formatting stays as typed (null)', () => {
    expect(userBlocks('just a plain message\nwith two lines')).toBeNull();
    expect(userBlocks('open snake_case_name and *.ts files, 5 * 3 = 15')).toBeNull();
    expect(userBlocks('# not a title\n| a | b |\n|---|---|\n| 1 | 2 |')).toBeNull();
    expect(userBlocks('colour #ff0000 and ![pic](plan.png)')).toBeNull();
  });
  it('bold, italic, strike, code, links', () => {
    const b = userBlocks('say **hi**, *there*, ~~old~~ `x` and [docs](https://example.com)')!;
    const kinds = (b[0] as { c: { t: string }[] }).c.map((t) => t.t);
    expect(kinds).toEqual(expect.arrayContaining(['bold', 'italic', 'strike', 'code', 'link']));
  });
  it('lists and quotes', () => {
    expect(userBlocks('- a\n- b')![0]!.t).toBe('ul');
    expect(userBlocks('1. a\n2. b')![0]!.t).toBe('ol');
    expect(userBlocks('> said')![0]!.t).toBe('quote');
  });
  it('a file reference written by a person is just text; strike works for agents too', () => {
    const b = userBlocks('see [plan](task:abc123/plan.png) and **bold**')!;
    const inl = (b[0] as { c: { t: string }[] }).c.map((t) => t.t);
    expect(inl).not.toContain('media');
    expect(inl).not.toContain('file');
    expect(parseMarkdown('~~gone~~')[0]).toMatchObject({ t: 'p', c: [{ t: 'strike' }] });
  });
});

describe('review fixes', () => {
  it('a message that only has an address typed as it is stays exactly as typed', () => {
    expect(userBlocks('see https://example.com/page for details')).toBeNull();
    expect(userBlocks('see https://example.com/page and **this**')).not.toBeNull();
    expect(userBlocks('[the docs](https://example.com)')).not.toBeNull();
  });
  it('a link text with unbalanced brackets cannot make the chat slow', () => {
    const t = Date.now();
    userBlocks('['.repeat(50_000));
    expect(Date.now() - t).toBeLessThan(400);
  });
});
