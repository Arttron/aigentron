/**
 * Pure helpers for the library scope (resources and knowledge bases are global or belong to one project).
 * A scope is `all`, `global` or a project slug; an item's own scope is a slug or null (global).
 */
import type { Project } from '@lds/shared';

export const SCOPE_ALL = 'all';
export const SCOPE_GLOBAL = 'global';
export const SCOPE_PARAM = 'project';

/** The slugs a scope name can never be (they are reserved words of the scope itself). */
const isWord = (v: string) => v === SCOPE_ALL || v === SCOPE_GLOBAL;

/** Scopes only appear when there is more than one project — a single-project setup looks exactly as before. */
export const hasScopes = (projects: readonly Pick<Project, 'slug'>[] | null | undefined): boolean => (projects?.length ?? 0) > 1;

/** Is the scope something that can be shown now (`all`, `global` or an existing project)? */
export function isScope(value: string | null | undefined, projects: readonly Pick<Project, 'slug'>[]): value is string {
  return !!value && (isWord(value) || projects.some((p) => p.slug === value));
}

/** The scope to start with: the `?project=` link wins, then the remembered one; each only if it still exists. Else `all`. */
export function initialScope(search: string, remembered: string | null, projects: readonly Pick<Project, 'slug'>[]): string {
  const fromUrl = new URLSearchParams(search).get(SCOPE_PARAM);
  if (isScope(fromUrl, projects)) return fromUrl;
  if (isScope(remembered, projects)) return remembered;
  return SCOPE_ALL;
}

/** The items a scope shows (`all` = everything). */
export function filterByScope<T extends { project?: string | null }>(items: readonly T[], scope: string): T[] {
  if (scope === SCOPE_ALL) return [...items];
  if (scope === SCOPE_GLOBAL) return items.filter((i) => !i.project);
  return items.filter((i) => i.project === scope);
}

/** `global`, or the project's name (the slug when the project is not in the list any more). */
export function scopeLabel(project: string | null | undefined, projects: readonly Pick<Project, 'slug' | 'name'>[]): string {
  if (!project) return SCOPE_GLOBAL;
  return projects.find((p) => p.slug === project)?.name ?? project;
}

/** Who sees an item of this scope — one line for a form. */
export function scopeHelp(project: string | null | undefined, projects: readonly Pick<Project, 'slug' | 'name'>[]): string {
  return project ? `Only agents working on ${scopeLabel(project, projects)} see it.` : 'Every agent of every project sees it.';
}

/** The project an item is created in: the picked scope, or the "Add to" choice when the scope is `all` ('' = global → null). */
export function targetProject(scope: string, addTo: string): string | null {
  const v = scope === SCOPE_ALL ? addTo : scope;
  return !v || v === SCOPE_GLOBAL ? null : v;
}

/** The select value (`''` = global) of an item's scope. */
export const scopeValue = (project: string | null | undefined): string => project ?? '';

/** The link to a page pre-filtered to a project. */
export const scopedHref = (page: '/resources' | '/knowledge', slug: string): string => `${page}?${SCOPE_PARAM}=${encodeURIComponent(slug)}`;

/** "Resources: 3 · Knowledge bases: 1", or '' when the server does not report the counts. */
export function libraryLine(counts: { resources?: number; knowledge?: number } | undefined): string {
  if (!counts || (counts.resources === undefined && counts.knowledge === undefined)) return '';
  return `Resources: ${counts.resources ?? 0} · Knowledge bases: ${counts.knowledge ?? 0}`;
}

const key = (page: string) => `lds.scope.${page}`;
export function readScopePref(page: string): string | null {
  try {
    return localStorage.getItem(key(page));
  } catch {
    return null;
  }
}
export function writeScopePref(page: string, scope: string): void {
  try {
    localStorage.setItem(key(page), scope);
  } catch {
    /* not remembered */
  }
}
const MULTI_KEY = 'lds.multiProject';
/** Whether the last answer had several projects — lets the bar reserve its height before the projects arrive. */
export function readMultiPref(): boolean {
  try {
    return localStorage.getItem(MULTI_KEY) === '1';
  } catch {
    return false;
  }
}
export function writeMultiPref(multi: boolean): void {
  try {
    localStorage.setItem(MULTI_KEY, multi ? '1' : '0');
  } catch {
    /* ignore */
  }
}
