// Quoting in the chat: a message (or a part of one) goes into the message box as a Markdown quote — `> …` on every line.

/** A quoted piece is cut here (with a note). */
export const QUOTE_MAX = 6000;

/** The text as a Markdown quote block (no trailing newline); '' for an empty text. */
export function quoteText(raw, max = QUOTE_MAX) {
  let t = String(raw ?? '').replace(/\r\n?/g, '\n').replace(/​/g, '').trim();
  if (!t) return '';
  if (t.length > max) {
    const cut = t.slice(0, max);
    const at = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('\n'));
    t = `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}\n[… cut]`;
  }
  return t
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}
