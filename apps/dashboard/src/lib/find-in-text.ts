/** Find in a conversation — helpers for the find bar (the matching itself is unit-tested; the DOM walk is checked in a browser). */

/** [start, end) of every case-insensitive occurrence of `needle` in `text` (no overlaps). */
export function findOffsets(text: string, needle: string): [number, number][] {
  const n = needle.trim();
  if (!n) return [];
  const out: [number, number][] = [];
  const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'giu');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** The text nodes of `root` that a person can read (not inside buttons, scripts or anything marked data-find-skip). */
function textNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || p.closest('button, script, style, [data-find-skip], [hidden]')) return NodeFilter.FILTER_REJECT;
      return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** A Range for every occurrence of `needle` in the readable text under `root`, in document order. */
export function findRanges(root: HTMLElement, needle: string): Range[] {
  const ranges: Range[] = [];
  for (const node of textNodes(root)) {
    for (const [a, b] of findOffsets(node.nodeValue ?? '', needle)) {
      const r = document.createRange();
      r.setStart(node, a);
      r.setEnd(node, b);
      ranges.push(r);
    }
  }
  return ranges;
}

/** Paints the matches (and the current one) with the browser's highlight registry; false when it has none (the count and the scrolling still work). */
export function paintMatches(all: Range[], current: Range | null): boolean {
  const reg = (typeof CSS !== 'undefined' ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined) as Map<string, unknown> | undefined;
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !H) return false;
  reg.set('find-all', new H(...all));
  if (current) reg.set('find-current', new H(current));
  else reg.delete('find-current');
  return true;
}

export function clearMatches(): void {
  const reg = (typeof CSS !== 'undefined' ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined) as Map<string, unknown> | undefined;
  reg?.delete('find-all');
  reg?.delete('find-current');
}
