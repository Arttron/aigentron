/** Pure helpers for the Projects pages (slug preview, repository labels, connection-test checklist, project choice). */
import type { Project, ProjectRepoAuth } from '@lds/shared';
import type { RepoProviderKind, RepoTestResult, RepoTestStep } from './api';

export const SLUG_MAX = 40;
const RESERVED = ['default', 'new', 'api', 'trash'];

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u', ђ: 'dj', ј: 'j', љ: 'lj', њ: 'nj', ћ: 'c', џ: 'dz', ѓ: 'gj', ќ: 'kj', ѕ: 'dz',
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r',
  σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o', ł: 'l', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', þ: 'th', ı: 'i',
};

/**
 * A preview of the slug the server will derive from a name ("Кухня 2" → "kukhnya-2"). The server is the authority
 * (it also makes the slug unique); this only mirrors it so a person sees the folder name while typing.
 */
export function slugFromName(name: string): string {
  const ascii = Array.from(name.trim().normalize('NFC'))
    .map((ch) => CYR[ch.toLowerCase()] ?? ch)
    .join('')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug || 'project';
}

/** The slug shown next to the name: the derived one, `-2`, `-3`… when taken (as the server does), never a reserved one. */
export function previewSlug(name: string, taken: readonly string[]): string {
  const base = slugFromName(name);
  const used = (s: string) => taken.includes(s) || RESERVED.includes(s);
  if (!used(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const cand = base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, '') + suffix;
    if (!used(cand)) return cand;
  }
  return base;
}

/** The host, a short `owner/repo` and the provider of a repository address (https, ssh:// and scp-like git@host:org/repo). */
export interface RepoLabel {
  host: string;
  short: string;
  provider: RepoProviderKind;
}

export function repoLabel(url: string | null | undefined): RepoLabel | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  let host = '';
  let path = '';
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  } else if (scp && !raw.startsWith('/')) {
    host = scp[1];
    path = scp[2];
  } else {
    return { host: '', short: raw.split('/').filter(Boolean).slice(-2).join('/') || raw, provider: 'generic' };
  }
  const short = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '') || host;
  const h = host.toLowerCase();
  const provider: RepoProviderKind = h === 'github.com' || h.endsWith('.github.com') ? 'github' : h.startsWith('gitlab.') || h === 'gitlab.com' ? 'gitlab' : h === 'bitbucket.org' ? 'bitbucket' : 'generic';
  return { host, short, provider };
}

/** One line for a card: `github.com · owner/repo`, or the host alone. */
export function repoLine(url: string | null | undefined): string {
  const l = repoLabel(url);
  if (!l) return '';
  return l.host ? `${l.host} · ${l.short}` : l.short;
}

export const PROVIDER_NAME: Record<RepoProviderKind, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', generic: 'Git server' };

/** Where a person creates an access token / deploy key for the provider (text for a link; generic → no link). */
export function providerTokenPage(provider: RepoProviderKind, host?: string): { label: string; href: string } | null {
  if (provider === 'github') return { label: 'github.com/settings/personal-access-tokens', href: 'https://github.com/settings/personal-access-tokens/new' };
  if (provider === 'gitlab') {
    const h = host && host.startsWith('gitlab.') ? host : 'gitlab.com';
    return { label: `${h} → Preferences → Access tokens`, href: `https://${h}/-/user_settings/personal_access_tokens` };
  }
  if (provider === 'bitbucket') return { label: 'Bitbucket → Repository settings → Access tokens', href: 'https://bitbucket.org/account/settings/app-passwords/' };
  return null;
}

/** Where the deploy keys of a repository are added. */
export function deployKeyPlace(provider: RepoProviderKind): string {
  if (provider === 'github') return 'GitHub → the repository → Settings → Deploy keys';
  if (provider === 'gitlab') return 'GitLab → the project → Settings → Repository → Deploy keys';
  if (provider === 'bitbucket') return 'Bitbucket → the repository → Repository settings → Access keys';
  return 'your git server (the repository’s deploy / access keys)';
}

export type StepMark = '✓' | '✕' | '–';
export const stepMark = (s: Pick<RepoTestStep, 'ok'>): StepMark => (s.ok === true ? '✓' : s.ok === false ? '✕' : '–');
export const stepTone = (s: Pick<RepoTestStep, 'ok'>): 'ok' | 'fail' | 'skip' => (s.ok === true ? 'ok' : s.ok === false ? 'fail' : 'skip');

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** The summary line under the checklist. */
export function testSummary(r: RepoTestResult): string {
  const steps = Array.isArray(r.steps) ? r.steps : [];
  const failed = steps.filter((s) => s.ok === false);
  const done = steps.filter((s) => s.ok === true).length;
  const head = r.ok ? `Connection works (${done} of ${steps.length} checks passed)` : `Connection failed at “${failed[0]?.label ?? 'a check'}”`;
  const branch = r.ok && r.defaultBranch ? ` · default branch ${r.defaultBranch}` : '';
  return `${head}${branch} · ${formatDuration(r.durationMs)}`;
}

/** "3 min ago", "2 h ago", "5 d ago", then the date. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return new Date(t).toLocaleDateString();
}

export const ISOLATION_HELP = {
  shared: 'Shared: every task works in the one checkout, one after another. Simple; changes pile up in one place.',
  worktree: 'Worktree: each task gets its own branch and folder and ends with a pull request. Tasks can run in parallel.',
} as const;

/** The projects a person can start a task in (archived ones are not offered), the default one first. */
export function selectableProjects(projects: readonly Project[]): Project[] {
  return projects.filter((p) => !p.archivedAt).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

/** The remembered choice if it is still offered, else the default project (else the first). */
export function pickProject(projects: readonly Project[], remembered: string | null): string {
  const list = selectableProjects(projects);
  return (remembered && list.find((p) => p.slug === remembered)?.slug) || list.find((p) => p.isDefault)?.slug || list[0]?.slug || '';
}

const PREF_KEY = 'lds.project';
export function readProjectPref(): string | null {
  try {
    return localStorage.getItem(PREF_KEY);
  } catch {
    return null;
  }
}
export function writeProjectPref(slug: string): void {
  try {
    localStorage.setItem(PREF_KEY, slug);
  } catch {
    /* not remembered */
  }
}

/** The text for an API failure: Nest answers `{"message": "..."}` (or a list of messages) — show just that. */
export function apiMessage(e: unknown): string {
  const raw = e instanceof Error ? ((e as { detail?: string }).detail ?? e.message) : String(e);
  try {
    const j = JSON.parse(raw) as { message?: string | string[] };
    if (Array.isArray(j.message)) return j.message.join('; ');
    if (typeof j.message === 'string') return j.message;
  } catch {
    /* plain text */
  }
  return raw.replace(/^\d+ [^—]*— /, '');
}


// ---- repository address vs. access mode (the field is checked as the person types) ---------------------------------

export type RepoUrlKind = 'ssh' | 'https' | 'http' | 'git' | 'file';

export interface ParsedUrl {
  kind: RepoUrlKind;
  host: string;
  /** `owner/repo` without `.git`, when the path has that shape */
  path: string;
  /** an `https://user:secret@…` address */
  hasCredentials: boolean;
}

/** What kind of address this is (null = not a repository address at all). */
export function parseRepoAddress(raw: string): ParsedUrl | null {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return null;
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(v);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    if (scp && scp[2]!.includes('/') && !v.startsWith('/')) return { kind: 'ssh', host: scp[1]!.toLowerCase(), path: scp[2]!.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, ''), hasCredentials: false };
    return null;
  }
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  const kind: RepoUrlKind | null = scheme === 'https' ? 'https' : scheme === 'http' ? 'http' : scheme === 'ssh' || scheme === 'git+ssh' ? 'ssh' : scheme === 'git' ? 'git' : scheme === 'file' ? 'file' : null;
  if (!kind || (kind !== 'file' && !u.hostname)) return null;
  return { kind, host: u.hostname.toLowerCase(), path: u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, ''), hasCredentials: Boolean(u.password || (u.username && kind !== 'ssh')) };
}

/** `https://github.com/org/repo(.git)` → `git@github.com:org/repo.git` (null when it has no host / owner / repo to convert). */
export function toSshAddress(raw: string): string | null {
  const p = parseRepoAddress(raw);
  if (!p || (p.kind !== 'https' && p.kind !== 'http') || !p.path.includes('/')) return null;
  return `git@${p.host}:${p.path}.git`;
}

/** `git@github.com:org/repo.git` → `https://github.com/org/repo.git`. */
export function toHttpsAddress(raw: string): string | null {
  const p = parseRepoAddress(raw);
  if (!p || p.kind !== 'ssh' || !p.host || !p.path.includes('/')) return null;
  return `https://${p.host}/${p.path}.git`;
}

export interface RepoUrlCheck {
  level: 'ok' | 'warn' | 'error';
  message: string;
  /** an address that would fix it, offered as a button */
  suggestion?: string;
}

/** Does the pasted address make sense for the chosen access mode? Empty = fine (a local folder, no remote). */
export function checkRepoUrl(raw: string, auth: ProjectRepoAuth): RepoUrlCheck {
  const v = raw.trim();
  if (!v) return { level: 'ok', message: '' };
  const p = parseRepoAddress(v);
  if (!p) return { level: 'error', message: 'That does not look like a repository address. Use https://github.com/org/repo.git or git@github.com:org/repo.git (no spaces).' };
  if (p.hasCredentials) return { level: 'error', message: 'Do not put a password or token in the address — choose “Token” below and paste it there (it is stored in a file, never in the address).' };
  if (p.kind !== 'file' && !p.path.includes('/')) return { level: 'warn', message: 'The address has no owner/repository part (expected …/org/repo.git).' };
  if (auth === 'ssh' && p.kind !== 'ssh') {
    const suggestion = toSshAddress(v) ?? undefined;
    return { level: 'error', message: `SSH key access needs an SSH address (git@${p.host || 'github.com'}:org/repo.git), but this one is ${p.kind}.`, suggestion };
  }
  if (auth === 'token' && p.kind === 'ssh') {
    const suggestion = toHttpsAddress(v) ?? undefined;
    return { level: 'error', message: 'Token access needs an https address (https://github.com/org/repo.git), but this one is an SSH address.', suggestion };
  }
  if (auth === 'token' && p.kind !== 'https') return { level: 'error', message: 'A token is sent only over https: use an https:// address.' };
  if (auth === 'none' && p.kind === 'ssh') return { level: 'warn', message: 'This is an SSH address: choose “SSH key” below and add the key to the repository, or switch to an https address if the repository is public.' };
  return { level: 'ok', message: '' };
}


/**
 * The agents the New task list of a project offers: the ones pinned to it, or every agent when nothing is pinned (as before). Pinned names
 * that no longer exist are ignored; if none of them exists any more, everything is offered rather than an empty list.
 */
export function offeredAgents<T extends { name: string }>(all: readonly T[], pinned: readonly string[] | null | undefined): T[] {
  if (!pinned?.length) return [...all];
  const set = new Set(pinned);
  const kept = all.filter((a) => set.has(a.name));
  return kept.length ? kept : [...all];
}
