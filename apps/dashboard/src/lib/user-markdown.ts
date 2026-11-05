import { parseMarkdown, type Block, type Inline } from './markdown-parse';

/**
 * What a person typed, as formatted blocks — or null when it holds no formatting at all (then it is shown exactly as typed, as before, so a plain
 * message never changes its look). Fenced blocks are split off by `splitFences` before this is called.
 */
export function userBlocks(text: string): Block[] | null {
  const blocks = parseMarkdown(text, { user: true });
  // an address typed as it is (its text is the address) is not formatting: such a message stays exactly as typed
  const bare = (t: Inline): boolean => t.t === 'link' && t.href.replace(/\/$/, '') === t.v.replace(/\/$/, '');
  const plainInline = (c: readonly Inline[]): boolean => c.every((t) => t.t === 'text' || bare(t));
  const plain = blocks.every((b) => b.t === 'p' && plainInline(b.c));
  return plain ? null : blocks;
}
