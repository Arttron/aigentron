/** Minimal YAML-ish frontmatter (`---` … `---`) parsing shared by agent/skill markdown readers. */
export interface Frontmatter {
  /** The trimmed raw lines between the `---` fences. */
  lines: string[];
  /** `key: value` pairs (single-line values; surrounding quotes stripped; blank/`#` lines skipped). */
  fields: Record<string, string>;
  /** The document after the closing fence. */
  body: string;
}

/** Parse the leading frontmatter block; null when the document has none. */
export function parseFrontmatter(raw: string): Frontmatter | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const lines = (m[1] ?? '').split(/\r?\n/).map((l) => l.trim());
  const fields: Record<string, string> = {};
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (key && value && !(key in fields)) fields[key] = value;
  }
  return { lines, fields, body: m[2] ?? '' };
}

/** A listable skill/agent document: `*.md`, but not a README. */
export const isListedMarkdown = (name: string): boolean => {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.endsWith('.md') && base.toLowerCase() !== 'readme.md';
};
