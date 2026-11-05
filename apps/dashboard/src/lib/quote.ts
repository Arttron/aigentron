/**
 * Quoting in the chat: a message (or a part of one) goes into the message box as a Markdown quote — `> …` on every line — so the reply says what it is about.
 * The conversation shows it as a quote, and agents read it as quoted text.
 */

/** A quoted piece is cut here (with a note): a whole long answer would cost the reader, and the agent, more than it helps. */
export const QUOTE_MAX = 6000;

/** The text as a Markdown quote block (no trailing newline). Empty text gives an empty string. */
export function quoteText(raw: string, max = QUOTE_MAX): string {
  let t = raw.replace(/\r\n?/g, '\n').replace(/​/g, '').trim();
  if (!t) return '';
  if (t.length > max) {
    // cut at the end of a paragraph / line when there is one near, so no sentence is left half-way
    const cut = t.slice(0, max);
    const at = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('\n'));
    t = `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}\n[… cut]`;
  }
  return t
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}

type Handler = (quote: string) => void;
const bus = new EventTarget();

/** Ask the message box of `scope` (a task id, or the admin chat) to take a quote. Returns false when nothing is listening. */
export function emitQuote(scope: string, quote: string): boolean {
  if (!quote) return false;
  const ev = new CustomEvent<{ quote: string; taken: boolean }>(`quote:${scope}`, { detail: { quote, taken: false } });
  bus.dispatchEvent(ev);
  return ev.detail.taken;
}

/** The message box of `scope` listens for quotes. */
export function onQuote(scope: string, handler: Handler): () => void {
  const fn = (e: Event) => {
    const d = (e as CustomEvent<{ quote: string; taken: boolean }>).detail;
    d.taken = true;
    handler(d.quote);
  };
  bus.addEventListener(`quote:${scope}`, fn);
  return () => bus.removeEventListener(`quote:${scope}`, fn);
}
