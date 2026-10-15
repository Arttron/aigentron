/**
 * Split an outgoing text into pieces a transport accepts (Telegram: 4096 UTF-16 units per message). Cuts fall on a
 * paragraph break, else a line break, else a space, else — for one giant word — right at the limit without splitting
 * an emoji / rare CJK character (a surrogate pair) in two. Nothing is lost: joining the pieces gives the text back
 * minus the whitespace at the cuts.
 */
export function splitForTransport(text: string, max: number): string[] {
  if (!Number.isFinite(max) || max < 2 || text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const { cut, skip } = findCut(rest, max);
    const piece = rest.slice(0, cut).replace(/\s+$/, '');
    rest = rest.slice(cut + skip);
    if (skip === 1 && rest.startsWith('\n')) rest = rest.replace(/^\n+/, ''); // a cut at the first of several line breaks
    if (piece) out.push(piece);
  }
  if (rest.trim()) out.push(rest);
  return out.length ? out : [text.slice(0, max)];
}

/** Where to cut `s` so the first piece is at most `max` long; `skip` = separator characters dropped at the cut. */
function findCut(s: string, max: number): { cut: number; skip: number } {
  const floor = Math.floor(max / 4); // never leave a tiny crumb just to honour a boundary
  const para = s.lastIndexOf('\n\n', max - 2);
  if (para >= floor) return { cut: para, skip: 2 };
  const line = s.lastIndexOf('\n', max - 1);
  if (line >= floor) return { cut: line, skip: 1 };
  const space = s.lastIndexOf(' ', max - 1);
  if (space >= floor) return { cut: space, skip: 1 };
  let cut = max;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1; // the cut would fall between the halves of a surrogate pair
  return { cut, skip: 0 };
}
