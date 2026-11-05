// Formatting of the message being typed, as pure text edits ({ text, start, end } in, the same out) — the same rules as the dashboard's message box
// (apps/dashboard/src/lib/md-edit.ts); the side panel keeps its own copy because the extension has no build step that could share the TypeScript.

const MARK = { bold: '**', italic: '*', strike: '~~', code: '`' };

export function toggleWrap(e, mark) {
  const { text, start, end } = e;
  const sel = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (before.endsWith(mark) && after.startsWith(mark) && !(mark === '*' && (before.endsWith('**') || after.startsWith('**')))) {
    return { text: before.slice(0, -mark.length) + sel + after.slice(mark.length), start: start - mark.length, end: end - mark.length };
  }
  if (mark !== '*') {
    const n = sel.split(mark).length - 1;
    if (n >= 4 || (n >= 2 && !(sel.startsWith(mark) && sel.endsWith(mark)))) {
      const plain = sel.split(mark).join('');
      return { text: before + plain + after, start, end: start + plain.length };
    }
  }
  if (sel.length >= mark.length * 2 && sel.startsWith(mark) && sel.endsWith(mark) && !(mark === '*' && sel.startsWith('**'))) {
    const inner = sel.slice(mark.length, sel.length - mark.length);
    return { text: before + inner + after, start, end: start + inner.length };
  }
  if (start === end) return { text: before + mark + mark + after, start: start + mark.length, end: start + mark.length };
  const lead = /^\s*/.exec(sel)[0];
  const trail = /\s*$/.exec(sel.slice(lead.length))[0];
  const core = sel.slice(lead.length, sel.length - trail.length);
  if (!core) return { text: before + mark + mark + sel + after, start: start + mark.length, end: start + mark.length };
  return { text: before + lead + mark + core + mark + trail + after, start: start + lead.length + mark.length, end: start + lead.length + mark.length + core.length };
}

export function insertLink(e, url) {
  const { text, start, end } = e;
  const label = text.slice(start, end) || 'link';
  const target = url ?? 'url';
  const out = `[${label}](${target})`;
  const next = text.slice(0, start) + out + text.slice(end);
  if (url !== undefined) return { text: next, start: start + out.length, end: start + out.length };
  const at = start + 1 + label.length + 2;
  return { text: next, start: at, end: at + target.length };
}

/** An address pasted over a selected word makes the word its link text. Null when it does not apply. */
export function pasteLinkOverSelection(e, clip) {
  const url = String(clip).trim();
  if (e.start === e.end || !/^https?:\/\/\S+$/i.test(url) || /\n/.test(e.text.slice(e.start, e.end))) return null;
  return insertLink(e, url);
}

/** A quote goes after the caret (or the selection), on its own paragraph, the caret on the blank line below it. */
export function insertQuote(e, quote) {
  const { text } = e;
  const at = e.end;
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const ins = `${lead}${quote}\n\n`;
  const tail = !after ? '' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '';
  const caret = before.length + ins.length;
  return { text: before + ins + tail + after, start: caret, end: caret };
}

/** Shift+Enter in a list / quote continues it; on an empty item the marker goes away. Null when the caret is not in one. */
export function continueList(e) {
  if (e.start !== e.end) return null;
  const { text, start } = e;
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const line = text.slice(from, start);
  const ul = /^(\s*)([-*])\s+(.*)$/.exec(line);
  const ol = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line);
  const q = /^(\s*)>\s?(.*)$/.exec(line);
  if (!(ul || ol || q)) return null;
  const content = ul ? ul[3] : ol ? ol[4] : q[2];
  if (!content.trim()) {
    const nlAt = text.indexOf('\n', start);
    if (text.slice(start, nlAt === -1 ? text.length : nlAt).trim()) return null;
    return { text: text.slice(0, from) + text.slice(start), start: from, end: from };
  }
  const marker = ul ? `${ul[1]}${ul[2]} ` : ol ? `${ol[1]}${Number(ol[2]) + 1}${ol[3]} ` : `${q[1]}> `;
  const ins = `\n${marker}`;
  return { text: text.slice(0, start) + ins + text.slice(start), start: start + ins.length, end: start + ins.length };
}

export const applyFormat = (e, action) => (action === 'link' ? insertLink(e) : toggleWrap(e, MARK[action]));

/** The action a ⌘/Ctrl combination stands for (B, I, K, Shift+X strike, Shift+C code), or null. */
export function shortcutAction(k) {
  if (!(k.metaKey || k.ctrlKey) || k.altKey) return null;
  const key = String(k.key).toLowerCase();
  if (!k.shiftKey) return key === 'b' ? 'bold' : key === 'i' ? 'italic' : key === 'k' ? 'link' : null;
  return key === 'x' ? 'strike' : key === 'c' ? 'code' : null;
}

/** The smallest replacement that turns `before` into `after` (so the browser's own editing command can make it and Ctrl+Z still undoes it). */
export function diffRange(before, after) {
  let a = 0;
  const max = Math.min(before.length, after.length);
  while (a < max && before[a] === after[a]) a++;
  let b = 0;
  while (b < max - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
  return { from: a, to: before.length - b, insert: after.slice(a, after.length - b) };
}
