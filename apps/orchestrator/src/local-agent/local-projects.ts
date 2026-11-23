import { parseRepoUrl } from '../projects/project-core';

export interface LocalProject {
  id: string;
  slug: string;
  name: string;
  /** the repository address with any credentials removed; only https / ssh / git (never a local path or `file:`) */
  repoUrl: string;
  branch?: string;
}

/**
 * The projects a computer may fetch (`aigentron open <project>`): those with a repository address a person's own git can clone. Credentials inside an address are
 * dropped (a clone uses the person's own git login), and an address that is not https / ssh / git — a local path, `file:`, `ext::` — is not offered at all.
 */
export function cloneableProjects(rows: { id: string; slug: string; name: string; repoUrl?: string | null; repoBranch?: string | null }[]): LocalProject[] {
  const out: LocalProject[] = [];
  for (const r of rows) {
    if (!r.repoUrl || /^-/.test(r.repoUrl.trim())) continue;
    const p = parseRepoUrl(r.repoUrl);
    if (!p || !['https', 'ssh', 'git'].includes(p.protocol)) continue;
    out.push({ id: r.id, slug: r.slug, name: r.name, repoUrl: p.url, ...(r.repoBranch ? { branch: r.repoBranch } : {}) });
  }
  return out;
}
