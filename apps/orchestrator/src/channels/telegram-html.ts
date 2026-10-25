/**
 * Plain chat text (what the agents write: a little Markdown, file names, paths) → Telegram's HTML subset. Pure.
 *
 * Why: Telegram links anything that looks like `name.tld`, and `.md`, `.sh`, `.py`, `.rs`, `.zip` … are real top-level domains, so `progress.md`
 * showed up as a link to a website. File names and paths go into `<code>` (Telegram never links code), and the usual Markdown (bold, italic, inline and fenced code, headings,
 * bullets, `[text](https://…)`) is shown as formatting instead of stray `**` and backticks. Everything else is escaped, so the text can never break the markup.
 */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');

/** Extensions that mean "a file", not "a website" (matched case-insensitively). */
const FILE_EXT = [
  'md', 'mdx', 'txt', 'rst', 'json', 'jsonl', 'yml', 'yaml', 'toml', 'ini', 'env', 'lock', 'xml', 'csv', 'tsv', 'log', 'sql', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'vue', 'svelte', 'lua', 'pl',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'mp3', 'wav', 'mp4', 'mov', 'webm', 'zip', 'tar', 'gz', 'tgz', 'dmg', 'exe', 'apk', 'ipa',
]
  .sort((a, b) => b.length - a.length)
  .join('|');

// `dir/name.ext`, `name.ext`, `./a/b.ext`: not glued to other word characters, an `@` (an e-mail), a `:` / `//` (a URL) or another dot
const FILE_RE = new RegExp(String.raw`(?<![\w/@.:~\\\-])((?:\.{0,2}\/)?(?:[\w.\-~]+\/)*[\w\-~][\w.\-~]*\.(?:${FILE_EXT}))(?![\w@/\-]|\.\w)`, 'gi');

const OPEN = '';
const CLOSE = '';

/** Formatting of one stretch of text that holds no code. */
function inline(text: string): string {
  const keep: string[] = [];
  const hold = (html: string): string => {
    keep.push(html);
    return `${OPEN}${keep.length - 1}${CLOSE}`;
  };
  let s = text;
  // [label](https://url) → a link; a bare URL stays as typed (Telegram links it) but is protected from the rules below
  s = s.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g, (_m, label: string, url: string) => hold(`<a href="${escAttr(url)}">${esc(label)}</a>`));
  s = s.replace(/https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"»]/g, (url) => hold(esc(url)));
  s = esc(s);
  s = s.replace(/^(\s*)#{1,6}\s+(.+)$/gm, '$1<b>$2</b>'); // headings
  s = s.replace(/^(\s*)[-*]\s+(?=\S)/gm, '$1• '); // bullets
  s = s.replace(/\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g, '<b>$1</b>');
  s = s.replace(/(?<![\w_])__(?=\S)([^\n]+?)(?<=\S)__(?![\w_])/g, '<b>$1</b>');
  s = s.replace(/(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/g, '<i>$1</i>');
  s = s.replace(/(?<![\w_])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w_])/g, '<i>$1</i>');
  s = s.replace(FILE_RE, '<code>$1</code>');
  return s.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_m, i: string) => keep[Number(i)]!);
}

export function toTelegramHtml(text: string): string {
  const out: string[] = [];
  // fenced blocks first, then inline code spans; everything between is ordinary text
  const parts = text.split(/(```[^\n]*\n[\s\S]*?```|`[^`\n]+`)/g);
  for (const part of parts) {
    if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
      const body = part.replace(/^```[^\n]*\n/, '').replace(/```$/, '').replace(/\n$/, '');
      out.push(`<pre>${esc(body)}</pre>`);
    } else if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      out.push(`<code>${esc(part.slice(1, -1))}</code>`);
    } else out.push(inline(part));
  }
  return out.join('');
}
