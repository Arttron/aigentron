/**
 * The project's shared library ("resources"): notes, images, PDFs and files every agent of the project may use as knowledge.
 * Pure helpers only (kinds, validation, search, the block that goes into an agent's prompt) — unit-tested.
 */

export type ResourceKind = 'text' | 'image' | 'pdf' | 'file';

export interface ResourceEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  kind: ResourceKind;
  /** Stored file name under <resources>/files. */
  file: string;
  /** Name it was uploaded with (or "<title>.md" for a note). */
  originalName: string;
  mime: string;
  size: number;
  /** Agent names this is meant for; empty = every agent. */
  agents: string[];
  /** Where it came from: upload | note | pack:<name>. */
  source: string;
  createdAt: string;
  updatedAt: string;
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
export const MAX_RESOURCES = 500;
/** A text resource is shown/edited in the dashboard and read whole by tools up to this size. */
export const MAX_TEXT_BYTES = 1024 * 1024;

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'log']);
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const OTHER_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  log: 'text/plain',
  pdf: 'application/pdf',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function kindFor(ext: string): ResourceKind {
  const e = ext.toLowerCase();
  if (TEXT_EXT.has(e)) return 'text';
  if (e in IMAGE_MIME) return 'image';
  if (e === 'pdf') return 'pdf';
  return 'file';
}
export const mimeFor = (ext: string): string => IMAGE_MIME[ext.toLowerCase()] ?? OTHER_MIME[ext.toLowerCase()] ?? 'application/octet-stream';
/** Safe to show inline in a browser (cannot run script). Everything else downloads. */
export const isInline = (kind: ResourceKind): boolean => kind === 'image' || kind === 'pdf';

export function cleanTags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,;\n]/) : [];
  const out: string[] = [];
  for (const t of raw) {
    const s = String(t).trim().toLowerCase().replace(/\s+/g, '-').slice(0, 30);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 12);
}

/** Why this metadata is unusable (null = fine). */
export function validateMeta(m: { title?: unknown; description?: unknown }): string | null {
  const title = typeof m.title === 'string' ? m.title.trim() : '';
  if (!title) return 'give a title.';
  if (title.length > 120) return 'the title is too long (max 120 characters).';
  if (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 600)) return 'the description is too long (max 600 characters).';
  return null;
}

/** A readable default title from an uploaded name: "../Кухня фото_1.PNG" → "Кухня фото 1". */
export function titleFromName(rawName: string): string {
  const base = rawName.split(/[\\/]/).pop() ?? rawName;
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (stem || 'Untitled').slice(0, 120);
}

/** "Quarterly plan.PDF" → "quarterly-plan.pdf" — a file name that is safe on every OS and inside a prompt. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) : '';
  return ext ? `${stem}.${ext}` : stem;
}

/** Does this resource apply to the agent? (Empty scope = everyone.) */
export const appliesTo = (r: Pick<ResourceEntry, 'agents'>, agentName?: string): boolean => r.agents.length === 0 || (!!agentName && r.agents.includes(agentName));

/** Simple relevance search over title, description, tags, name: every query word must hit; title hits rank first. */
export function search(list: ResourceEntry[], query?: string, tag?: string): ResourceEntry[] {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const t = tag?.trim().toLowerCase();
  const scored: { r: ResourceEntry; score: number }[] = [];
  for (const r of list) {
    if (t && !r.tags.includes(t)) continue;
    const title = r.title.toLowerCase();
    const rest = `${r.description} ${r.tags.join(' ')} ${r.originalName}`.toLowerCase();
    let score = 0;
    let ok = true;
    for (const w of words) {
      if (title.includes(w)) score += 3;
      else if (rest.includes(w)) score += 1;
      else ok = false;
    }
    if (ok) scored.push({ r, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.r.updatedAt.localeCompare(a.r.updatedAt)).map((s) => s.r);
}

/**
 * The block added to an agent's prompt: what the library contains and where to read it. Only entries that apply to this
 * agent; capped so a big library cannot flood the context (the agent can ask `resources_search` for the rest).
 */
export function promptBlock(list: ResourceEntry[], pathOf: (r: ResourceEntry) => string, agentName?: string, limit = 25): string {
  const mine = list.filter((r) => appliesTo(r, agentName)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!mine.length) return '';
  const shown = mine.slice(0, limit);
  const lines = shown.map((r) => `- ${r.title}${r.description ? ` — ${r.description.replace(/\s+/g, ' ').slice(0, 160)}` : ''}${r.tags.length ? ` [${r.tags.join(', ')}]` : ''} (${r.kind}) → ${pathOf(r)}`);
  return [
    '## Project resources',
    'The project keeps a shared library of notes, images and documents. Treat it as the source of truth for this project\'s facts, preferences, measurements and reference material: BEFORE answering from memory or guessing, check this list, and when an entry is relevant READ it (Read the path; images and PDFs are readable too) and follow it. Never invent what a resource would say. Never modify these files.',
    ...lines,
    mine.length > shown.length ? `(+${mine.length - shown.length} more — call the \`resources_search\` tool with a query or tag to find them.)` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Text answer for the `resources_search` tool. */
export function searchReport(found: ResourceEntry[], pathOf: (r: ResourceEntry) => string, limit = 20): string {
  if (!found.length) return 'No matching resources.';
  const lines = found.slice(0, limit).map((r) => `${r.id} | ${r.title} | ${r.kind} | ${r.tags.join(',') || '-'} | ${r.description.replace(/\s+/g, ' ').slice(0, 120)} | ${pathOf(r)}`);
  return `${found.length} match(es)${found.length > limit ? ` (showing ${limit})` : ''} — id | title | kind | tags | description | path (Read it):\n${lines.join('\n')}`;
}
