import type { ProjectRef } from '@lds/shared';
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_SLUG } from './project-core';

/**
 * id → { slug, name } of every project, kept by ProjectsService (loaded at boot, refreshed on every change).
 * A task is serialized in many places from a bare row (bus events after a status change, approvals, questions)
 * where loading the relation would cost a query each time — the label comes from here instead. Projects are
 * few and change rarely; the only stale case is another orchestrator instance creating one (full profile),
 * which the next list/get on this instance refreshes.
 */
const labels = new Map<string, ProjectRef>([[DEFAULT_PROJECT_ID, { slug: DEFAULT_PROJECT_SLUG, name: DEFAULT_PROJECT_NAME }]]);

/** Shown for a project id the cache does not know (never expected after boot). */
export const UNKNOWN_PROJECT: ProjectRef = { slug: 'unknown', name: 'Unknown project' };

export function setProjectLabels(rows: { id: string; slug: string; name: string }[]): void {
  labels.clear();
  for (const r of rows) labels.set(r.id, { slug: r.slug, name: r.name });
  if (!labels.has(DEFAULT_PROJECT_ID)) labels.set(DEFAULT_PROJECT_ID, { slug: DEFAULT_PROJECT_SLUG, name: DEFAULT_PROJECT_NAME });
}

export function setProjectLabel(row: { id: string; slug: string; name: string }): void {
  labels.set(row.id, { slug: row.slug, name: row.name });
}

export function dropProjectLabel(id: string): void {
  labels.delete(id);
}

export function projectLabel(id: string | null | undefined): ProjectRef {
  return (id && labels.get(id)) || UNKNOWN_PROJECT;
}

export function knownProjectLabel(id: string): ProjectRef | null {
  return labels.get(id) ?? null;
}

/** The id behind a slug, from the cache (null when unknown here). */
export function projectIdOfSlug(slug: string): string | null {
  for (const [id, ref] of labels) if (ref.slug === slug) return id;
  return null;
}
