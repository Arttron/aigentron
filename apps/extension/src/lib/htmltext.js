// Reading a page WITHOUT running a script in it: for the pages Chrome forbids extensions to script (its own Web Store, chrome:// pages). The extension fetches the
// HTML like any client and takes out what is in the source: the title, the descriptions, the structured data, snippets of embedded JSON that mention ratings or
// users, and the visible text. A page that draws itself with scripts may leave most of this empty — the note says so.

/** Pages an extension cannot inject scripts into (the browser refuses): the Chrome Web Store and the browser's own pages. */
export function isScriptBlocked(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:' || u.protocol === 'edge:' || u.protocol === 'about:') return true;
    if (u.hostname === 'chromewebstore.google.com') return true;
    return u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore');
  } catch {
    return false;
  }
}

/** Does this error come from the browser refusing to script a page? */
export const isScriptRefusal = (err) => /cannot be scripted|cannot access (contents of )?(the )?(page|url)|extensions gallery|cannot access a chrome/i.test(String(err?.message ?? err ?? ''));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (ENTITIES[k] !== undefined) return ENTITIES[k];
  if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16) || 32);
  if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10) || 32);
  return m;
});
const tidy = (s) => decode(s).replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function metaOf(html) {
  const out = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const val = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && val && /^(description|og:title|og:description|og:site_name|twitter:title|twitter:description|keywords)$/.test(key)) out.push(`${key}: ${tidy(val)}`);
  }
  return [...new Set(out)];
}

/** The text of a page's source, ready for a model: `{ title, url, text, more, offset, total, source: 'fetched' }`. */
export function readableFromHtml(html, url, offset = 0, max = 12000) {
  const src = String(html ?? '');
  const title = tidy((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1]) ?? '');
  const parts = [];
  const meta = metaOf(src);
  if (meta.length) parts.push(`## Descriptions\n${meta.join('\n')}`);
  const ld = [];
  for (const m of src.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      ld.push(JSON.stringify(JSON.parse(m[1])).slice(0, 3000));
    } catch {
      /* not valid JSON */
    }
  }
  if (ld.length) parts.push(`## Structured data\n${ld.join('\n')}`);
  // numbers a page keeps in its own embedded data (ratings, user counts): a few snippets around the words
  const snippets = [];
  for (const m of src.matchAll(/<script\b(?![^>]*type\s*=\s*["']application\/ld)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1];
    const hit = /(ratingValue|ratingCount|aggregateRating|userCount|user_count|"users"|installs|install count)/i.exec(body);
    if (hit) snippets.push(body.slice(Math.max(0, hit.index - 150), hit.index + 350).replace(/\s+/g, ' '));
    if (snippets.length >= 5) break;
  }
  if (snippets.length) parts.push(`## Embedded data (raw)\n${snippets.join('\n…\n')}`);
  const visible = tidy(
    src
      .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  );
  if (visible) parts.push(`## Text of the page source\n${visible}`);
  const text = parts.join('\n\n');
  // a page that gave almost nothing (an empty shell drawn by scripts): the caller adds a picture of it
  const thin = !ld.length && !snippets.length && visible.length < 1200;
  const start = Math.max(0, Number(offset) || 0);
  const end = Math.min(text.length, start + (Number(max) || 12000));
  return { title, url, text: text.slice(start, end), more: end < text.length, offset: end, total: text.length, source: 'fetched', thin };
}

export const FETCHED_NOTE =
  'Chrome does not let an extension run scripts on this page (its own pages, the Web Store), so this is the text of the page SOURCE fetched without the browser, not the live page: there are no [eN] references to click, and numbers the page draws with its own scripts (ratings, user counts) may be missing. Say so in your answer if a number you need is not here; do not guess it.';

export const FETCHED_THIN_NOTE = ' The source had almost nothing in it (the page draws itself with scripts), so a picture of the page is added: read the numbers and text from it.';
