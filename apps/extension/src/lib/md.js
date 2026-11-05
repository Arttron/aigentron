// A small, SAFE Markdown renderer for agent messages in the side panel: it builds DOM nodes with textContent only (no innerHTML), so nothing an agent
// writes can become markup. Supports paragraphs, fenced code, lists, quotes (`> …`), headings (as bold lines), **bold**, *italic*, ~~strike~~, `code` and [text](http(s) links).

const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)\[]+)\)/g;

/** A mark hugs its text: no space just inside it, and no letter or digit just outside. */
function hugs(src, at, tok, mark) {
  const inner = tok.slice(mark, tok.length - mark);
  if (!inner || /^\s|\s$/.test(inner)) return false;
  const prev = src[at - 1];
  const next = src[at + tok.length];
  return !(prev && /[\p{L}\p{N}]/u.test(prev)) && !(next && /[\p{L}\p{N}]/u.test(next));
}

/** Inline: **bold**, *italic*, ~~strike~~, `code`, [text](url) → an array of nodes. */
export function inline(text) {
  const out = [];
  const re = /(\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\s][^*\n]*\*|`[^`]+`|\[[^\[\]]+\]\(https?:\/\/[^\s)\[]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const t = m[0];
    // a mark counts only when it hugs its text (`*.ts files, 5 * 3` and `snake_case` stay as typed)
    if (/^(\*\*|~~|\*)/.test(t) && !hugs(text, m.index, t, t.startsWith('*') && !t.startsWith('**') ? 1 : 2)) continue;
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (t.startsWith('**')) out.push(Object.assign(document.createElement('strong'), { textContent: t.slice(2, -2) }));
    else if (t.startsWith('~~')) out.push(Object.assign(document.createElement('del'), { textContent: t.slice(2, -2) }));
    else if (t.startsWith('*')) out.push(Object.assign(document.createElement('em'), { textContent: t.slice(1, -1) }));
    else if (t.startsWith('`')) out.push(Object.assign(document.createElement('code'), { textContent: t.slice(1, -1) }));
    else {
      LINK.lastIndex = 0;
      const l = LINK.exec(t);
      if (l) out.push(Object.assign(document.createElement('a'), { textContent: l[1], href: l[2], target: '_blank', rel: 'noreferrer noopener' }));
      else out.push(document.createTextNode(t));
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** Block structure → a list of {type, ...} (pure; the DOM part is `render`). */
export function blocks(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push({ type: 'code', text: code.join('\n') });
    } else if (/^\s*>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ type: 'quote', text: q.join('\n') });
    } else if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+[.)])\s+/, ''));
      out.push({ type: 'list', items });
    } else if (/^#{1,6}\s+/.test(line)) {
      out.push({ type: 'heading', text: line.replace(/^#{1,6}\s+/, '') });
      i++;
    } else if (!line.trim()) i++;
    else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]) && !/^#{1,6}\s+/.test(lines[i])) para.push(lines[i++]);
      out.push({ type: 'p', text: para.join('\n') });
    }
  }
  return out;
}

export function render(src) {
  const root = document.createElement('div');
  for (const b of blocks(src)) {
    if (b.type === 'code') root.append(Object.assign(document.createElement('pre'), { textContent: b.text }));
    else if (b.type === 'list') {
      const ul = document.createElement('ul');
      for (const it of b.items) {
        const li = document.createElement('li');
        li.append(...inline(it));
        ul.append(li);
      }
      root.append(ul);
    } else if (b.type === 'quote') {
      const q = document.createElement('blockquote');
      q.append(...inline(b.text));
      root.append(q);
    } else if (b.type === 'heading') {
      const s = document.createElement('strong');
      s.append(...inline(b.text));
      const p = document.createElement('p');
      p.append(s);
      root.append(p);
    } else {
      const p = document.createElement('p');
      p.append(...inline(b.text));
      root.append(p);
    }
  }
  return root;
}
