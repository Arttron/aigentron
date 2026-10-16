/** Pure helpers of the shared workspace (no IO): note formatting, safe paths, globs, the prompt digest. */
import { servePolicy } from '../files/file-types';

export const NOTE_KINDS = ['decision', 'question', 'fact', 'status', 'plan'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** The file of each note kind under `memory/`. `status` replaces its file, the rest append. */
export const MEMORY_FILES: Record<NoteKind, string> = {
  decision: 'decisions.md',
  question: 'questions.md',
  fact: 'facts.md',
  plan: 'plan.md',
  status: 'status.md',
};

export const MAX_NOTE_CHARS = 2000;
export const MAX_MEMORY_FILE_BYTES = 256 * 1024;
export const MAX_SAVE_BYTES = 50 * 1024 * 1024;

export const BRIEF_TEMPLATE = `# Workspace brief

<!-- Fill in (a person, or the admin on request): agents read this at the start of every task. Keep it short. -->

- **Goal:**
- **Constraints (budget, deadlines, standards, language):**
- **Success criteria:**
- **Who decides:**
`;

const HEADERS: Record<NoteKind, string> = {
  decision: '# Decisions\n\nWhat was decided, by whom and why (newest last).\n',
  question: '# Open questions\n\n`- [ ]` open, `- [x]` answered.\n',
  fact: '# Facts and requirements\n',
  plan: '# Plan\n',
  status: '# Status\n\n(one screen: where we are, what is next, what blocks)\n',
};
export const memoryHeader = (k: NoteKind): string => HEADERS[k];

const pad = (n: number) => String(n).padStart(2, '0');
export const stamp = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;

export function cleanText(text: string): string {
  return text.replace(/\r/g, '').trim();
}

/** One dated line (or block) for an append-only memory file. */
export function formatNote(kind: NoteKind, text: string, now: Date, by?: string): string {
  const body = cleanText(text).replace(/\n+/g, '\n  ');
  const who = by ? ` (${by})` : '';
  const mark = kind === 'question' ? '- [ ] ' : '- ';
  return `${mark}${stamp(now)}${who} — ${body}\n`;
}

/** Marks the first OPEN question whose text contains `fragment` as answered; null when none matches. */
export function resolveQuestion(content: string, fragment: string): string | null {
  const needle = fragment.trim().toLowerCase();
  if (!needle) return null;
  const lines = content.split('\n');
  const i = lines.findIndex((l) => l.startsWith('- [ ] ') && l.toLowerCase().includes(needle));
  if (i < 0) return null;
  lines[i] = lines[i]!.replace('- [ ] ', '- [x] ');
  return lines.join('\n');
}

/** A relative path inside a folder: no absolute paths, no `..`, no hidden/version folders. Returns the normalised path or null. */
export function safeRelative(path: string): string | null {
  const raw = path.replace(/\\/g, '/').trim();
  if (!raw || raw.startsWith('/') || raw.includes('\0') || /^[a-zA-Z]:/.test(raw)) return null;
  const parts = raw.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..' || p.startsWith('.'))) return null;
  return parts.join('/');
}

/** `*` any chars (not /), `**` any, `?` one char. Matched against the path relative to the listed folder. */
export function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '@@GLOBSTAR@@').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/@@GLOBSTAR@@/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

export const human = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

export interface MemoryParts {
  brief: string;
  status: string;
  decisions: string;
  questions: string;
}

/** The memory block of the prompt (≤ ~6 KB): the brief (unless untouched), the status, the last decisions, the open questions. */
export function buildDigest(p: MemoryParts, briefTemplate = BRIEF_TEMPLATE): string {
  const untouched = (s: string, header: string) => !s.trim() || s.trim() === header.trim();
  const out: string[] = [];
  if (!untouched(p.brief, briefTemplate)) out.push(`### Brief (WORKSPACE.md)\n${clip(p.brief.trim(), 3500)}`);
  if (!untouched(p.status, HEADERS.status)) out.push(`### Status\n${clip(p.status.replace(/^# Status\n+/, '').trim(), 1400)}`);
  const decisions = p.decisions.split('\n').filter((l) => l.startsWith('- ')).slice(-15);
  if (decisions.length) out.push(`### Latest decisions\n${clip(decisions.join('\n'), 2000)}`);
  const open = p.questions.split('\n').filter((l) => l.startsWith('- [ ] ')).slice(-15);
  if (open.length) out.push(`### Open questions\n${clip(open.join('\n'), 1200)}`);
  return out.join('\n\n');
}

/** The short orientation block of the prompt (paths + where things go). */
export function orientationBlock(root: string): string {
  return [
    '## Shared workspace',
    `A shared folder for the team's non-code work (notes, drafts, results): \`${root}\` — your code stays where it is.`,
    `- \`work/\` — drafts, research notes, data; write freely.`,
    `- \`deliverables/\` — finished results for the person: save with \`workspace_save\` (keeps older versions; it also shows the file in this task's attachments).`,
    `- \`memory/\` — decisions, open questions, facts, plan, status: record with \`workspace_note\`, do not edit by hand.`,
    `- \`WORKSPACE.md\` — the brief (read-only for you; ask the person to change it).`,
    'Call `workspace_info` if unsure where something belongs; `workspace_files` lists what is there.',
  ].join('\n');
}

/** A glob without `/` matches the file name anywhere below the folder ("*.md" finds notes/a.md too); with `/` it matches the relative path. */
export function matchesGlob(glob: string, relPath: string): boolean {
  const re = globToRegex(glob);
  if (re.test(relPath)) return true;
  return !glob.includes('/') && re.test(relPath.split('/').pop() ?? relPath);
}

/** How a workspace file is served: the shared file-types policy (pictures / PDF / playable video inline, text as text/plain, the rest downloads). */
export const serveKind = (name: string): { mime: string; inline: boolean; text: boolean } => servePolicy(name);

/** The top-level entries of the workspace and what a person may change there. */
export const TOP_FOLDERS = ['memory', 'work', 'deliverables'] as const;
export const BRIEF_FILE = 'WORKSPACE.md';
export const MAX_BRIEF_BYTES = 64 * 1024;

/** `work/` takes uploads; the brief is editable; deletions only in work/ and deliverables/. */
export function canWrite(rel: string): boolean {
  return rel === BRIEF_FILE || rel.startsWith('work/');
}
export function canDelete(rel: string): boolean {
  return rel.startsWith('work/') || rel.startsWith('deliverables/');
}
