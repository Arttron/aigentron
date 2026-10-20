/**
 * Pure helpers for projects (docs/plan-projects-workspace.md §2): slugs, repository URLs, defaults.
 * No I/O, no Nest — tested on their own (project-core.test.ts).
 */
import { asciiFileName } from '../files/ascii-name';

export const PROJECT_KINDS = ['code', 'docs'] as const;
export const PROJECT_REPO_AUTHS = ['none', 'token', 'ssh'] as const;
export const PROJECT_ISOLATIONS = ['shared', 'worktree'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
export type ProjectRepoAuth = (typeof PROJECT_REPO_AUTHS)[number];
export type ProjectIsolation = (typeof PROJECT_ISOLATIONS)[number];

/** Id and slug of the default project — fixed, so migrations and code agree. */
export const DEFAULT_PROJECT_ID = 'proj_default';
export const DEFAULT_PROJECT_SLUG = 'default';
export const DEFAULT_PROJECT_NAME = 'Default';

/** Folder name: lowercase ASCII letters, digits and hyphens, 1–40 characters, not starting with a hyphen. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SLUG_MAX = 40;
/** Slugs no new project may take (`default` is the default project's; the rest are folder names of the platform). */
export const RESERVED_SLUGS: readonly string[] = [DEFAULT_PROJECT_SLUG, 'new', 'api', 'trash'];

export const PROJECT_DEFAULTS = { kind: 'code' as ProjectKind, repoBranch: 'main', repoAuth: 'none' as ProjectRepoAuth, verifyMaxAttempts: 2 } as const;

export const isProjectKind = (v: unknown): v is ProjectKind => typeof v === 'string' && (PROJECT_KINDS as readonly string[]).includes(v);
export const isRepoAuth = (v: unknown): v is ProjectRepoAuth => typeof v === 'string' && (PROJECT_REPO_AUTHS as readonly string[]).includes(v);
export const isIsolation = (v: unknown): v is ProjectIsolation => typeof v === 'string' && (PROJECT_ISOLATIONS as readonly string[]).includes(v);

/** A slug as typed: valid as is, or not at all (a slug is never silently changed — it names a folder). */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Why a typed slug cannot be used for a NEW project (null = fine). */
export function slugProblem(slug: string): string | null {
  if (!isValidSlug(slug)) return `slug "${slug}" must be 1–${SLUG_MAX} lowercase letters, digits or hyphens, starting with a letter or digit`;
  if (RESERVED_SLUGS.includes(slug)) return `slug "${slug}" is reserved`;
  return null;
}

/**
 * A slug derived from a display name: unicode names are transliterated the way stored file names are
 * ("Кухня 2" → "kukhnya-2"), then lowercased and squeezed to the slug alphabet. Empty (nothing readable) → "project".
 */
export function slugFromName(name: string): string {
  const ascii = asciiFileName(name.trim() || 'project');
  // asciiFileName says "file" when nothing of the name is readable — that is not a project name
  if (ascii === 'file' && !/file/i.test(name)) return 'project';
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug || 'project';
}

/** A slug that is free: the derived one, or `<slug>-2`, `-3`, … when taken (kept within the length limit). */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base) && !RESERVED_SLUGS.includes(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, '') + suffix;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`no free slug for "${base}"`);
}

export type RepoProvider = 'github' | 'gitlab' | 'bitbucket' | 'generic';

export interface ParsedRepoUrl {
  /** The URL with any embedded credentials removed (what may be logged / shown). */
  url: string;
  /** https | ssh (ssh:// and scp-like `git@host:org/repo.git` both) | http | git | file */
  protocol: 'https' | 'http' | 'ssh' | 'git' | 'file';
  host: string;
  /** `owner/repo` without `.git`, when the path has that shape (null for a bare host or a local path). */
  owner: string | null;
  repo: string | null;
  provider: RepoProvider;
  /** True when the URL itself carried a password / token (`https://x:ghp_…@host/…`). */
  hadCredentials: boolean;
}

function providerOf(host: string): RepoProvider {
  const h = host.toLowerCase();
  if (h === 'github.com' || h.endsWith('.github.com')) return 'github';
  if (h === 'gitlab.com' || h.startsWith('gitlab.')) return 'gitlab';
  if (h === 'bitbucket.org' || h.startsWith('bitbucket.')) return 'bitbucket';
  return 'generic';
}

function ownerRepoOf(path: string): { owner: string | null; repo: string | null } {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length < 2) return { owner: null, repo: null };
  const repo = parts[parts.length - 1]!.replace(/\.git$/i, '');
  const owner = parts.slice(0, -1).join('/');
  return repo ? { owner, repo } : { owner: null, repo: null };
}

/** Strip userinfo (`user:token@`) from a URL before it is logged or shown. scp-like `git@host:…` keeps its user (not a secret). */
export function redactRepoUrl(url: string): string {
  const scp = /^([\w.-]+)@([\w.-]+):(.+)$/.exec(url.trim());
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url.trim();
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1');
}

/**
 * Classify a repository URL: `https://host/owner/repo(.git)`, `ssh://git@host[:port]/owner/repo.git`,
 * scp-like `git@host:owner/repo.git`, `git://`, `file:///path`. Null when it is none of these.
 */
export function parseRepoUrl(raw: string): ParsedRepoUrl | null {
  const url = raw.trim();
  if (!url || /\s/.test(url)) return null;
  const scp = /^(?:([\w.-]+)@)?([\w.-]+):(?!\/\/)(.+)$/.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && scp[3]!.includes('/') === true) {
    const host = scp[2]!;
    const { owner, repo } = ownerRepoOf(scp[3]!);
    return { url, protocol: 'ssh', host, owner, repo, provider: providerOf(host), hadCredentials: false };
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (scheme === 'https' || scheme === 'http' || scheme === 'ssh' || scheme === 'git' || scheme === 'git+ssh') {
    const host = u.hostname.toLowerCase();
    if (!host) return null;
    const { owner, repo } = ownerRepoOf(u.pathname);
    const hadCredentials = Boolean(u.password);
    const protocol = scheme === 'git+ssh' ? 'ssh' : (scheme as 'https' | 'http' | 'ssh' | 'git');
    return { url: redactRepoUrl(url), protocol, host, owner, repo, provider: providerOf(host), hadCredentials };
  }
  if (scheme === 'file') {
    return { url, protocol: 'file', host: '', owner: null, repo: null, provider: 'generic', hadCredentials: false };
  }
  return null;
}

/** The auth mode a URL implies when the person did not say: ssh for ssh-like URLs, none otherwise (a token is a choice). */
export function impliedRepoAuth(parsed: ParsedRepoUrl | null): ProjectRepoAuth {
  return parsed?.protocol === 'ssh' ? 'ssh' : 'none';
}

/** The isolation a project runs with: its own setting, else the installation's WORKSPACE_SHARED. */
export function effectiveIsolation(isolation: string | null | undefined, workspaceShared: boolean): ProjectIsolation {
  return isIsolation(isolation) ? isolation : workspaceShared ? 'shared' : 'worktree';
}

/** A subdirectory setting normalised to a safe relative path ('' = the repo root); `..`, absolute paths → ''. */
export function normalizeSubdir(sub: string | null | undefined): string {
  const s = (sub ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!s || s.split('/').some((p) => p === '..' || p === '')) return '';
  return s;
}

/** A branch name as git accepts it (the common subset); null when unusable. */
export function normalizeBranch(branch: string | null | undefined): string | null {
  const b = (branch ?? '').trim();
  if (!b || b.length > 200 || /[\s~^:?*[\\]|\.\.|^\/|\/$|^-|\.lock$|@\{/.test(b)) return null;
  return b;
}


/** An agent name as the registry allows it (also what may sit in a comma-separated list). */
const AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The stored `pinnedAgents` text (comma-separated) → names; anything unusable is dropped, duplicates removed, order kept. */
export function parsePinnedAgents(stored: string | null | undefined): string[] {
  return [...new Set((stored ?? '').split(',').map((s) => s.trim()).filter((s) => AGENT_NAME.test(s)))].slice(0, 50);
}

/** What an API caller sent → the text to store (null = no pins = every agent). A bad name or a non-list is refused, not silently dropped. */
export function serializePinnedAgents(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input)) throw new Error('pinnedAgents must be a list of agent names');
  const names = [...new Set(input.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean))];
  if (names.length > 50) throw new Error('at most 50 pinned agents');
  const bad = names.find((n) => !AGENT_NAME.test(n));
  if (bad) throw new Error(`"${bad}" is not an agent name (letters, digits, - and _)`);
  return names.length ? names.join(',') : null;
}
