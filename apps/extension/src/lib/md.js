// A small, SAFE Markdown renderer for agent messages in the side panel: it builds DOM nodes with textContent only (no innerHTML), so nothing an agent
// writes can become markup. Supports paragraphs, fenced code, lists, headings (as bold lines), **bold**, `code` and [text](http(s) links).

const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Inline: **bold**, `code`, [text](url) → an array of nodes. */
export function inline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    if (t.startsWith('**')) out.push(Object.assign(document.createElement('strong'), { textContent: t.slice(2, -2) }));
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
      while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]) && !/^#{1,6}\s+/.test(lines[i])) para.push(lines[i++]);
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
