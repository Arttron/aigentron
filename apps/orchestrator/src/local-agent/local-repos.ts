/** What a local agent reports about its repositories (event `repos`), cleaned: it is data from another machine, so shape and sizes are checked here. */
export interface RepoFile {
  path: string;
  xy: string;
}

export interface RepoStatus {
  id: string;
  path: string;
  branch: string;
  detached: boolean;
  head: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  state?: string;
  origin?: string;
  files: RepoFile[];
  filesCut?: boolean;
  error?: string;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? [...v].filter((c) => c.charCodeAt(0) >= 32).join('').slice(0, max) : '');
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1_000_000, Math.trunc(v))) : 0);

/** The `repos` event's data → a clean list (at most 50 repositories, 200 files each). Anything that is not shaped like a status is dropped. */
export function parseRepos(data: unknown): RepoStatus[] {
  const list = (data as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(list)) return [];
  const out: RepoStatus[] = [];
  for (const r of list.slice(0, 50)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = str(o.id, 32);
    if (!/^[0-9a-f]{8}$/.test(id)) continue;
    const files = Array.isArray(o.files) ? o.files.slice(0, 200).map((f) => ({ path: str((f as { path?: unknown })?.path, 400), xy: str((f as { xy?: unknown })?.xy, 2) })).filter((f) => f.path) : [];
    out.push({
      id,
      path: str(o.path, 500),
      branch: str(o.branch, 200),
      detached: o.detached === true,
      head: str(o.head, 40),
      ...(o.upstream ? { upstream: str(o.upstream, 200) } : {}),
      ahead: int(o.ahead),
      behind: int(o.behind),
      staged: int(o.staged),
      unstaged: int(o.unstaged),
      untracked: int(o.untracked),
      conflicted: int(o.conflicted),
      ...(o.state ? { state: str(o.state, 20) } : {}),
      ...(o.origin ? { origin: str(o.origin, 300) } : {}),
      files,
      ...(o.filesCut === true ? { filesCut: true } : {}),
      ...(o.error ? { error: str(o.error, 300) } : {}),
    });
  }
  return out;
}

/**
 * A remote address in one comparable form: `https://user:tok@GitHub.com/Acme/Shop.git`, `git@github.com:acme/shop.git` and `ssh://git@github.com:22/acme/shop` all
 * become `github.com/acme/shop`. A local `file://` remote keeps its path.
 */
export function normalizeRemote(raw: string | null | undefined): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)(.+)$/.exec(s);
  if (scp) s = `ssh://${scp[1]}/${scp[2]}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  const path = decodeURIComponent(u.pathname).replace(/\/+$/, '').replace(/\.git$/i, '');
  if (u.protocol === 'file:') return `file://${path}`;
  return `${u.hostname.toLowerCase()}${path.toLowerCase()}`;
}

export const sameRemote = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = normalizeRemote(a);
  return x !== '' && x === normalizeRemote(b);
};
