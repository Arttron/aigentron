/**
 * The runtime view of a project (docs/plan-projects-workspace.md §2.4–2.6): everything the worker, the executor, the
 * provisioner and the verify gate need to know about the project a task belongs to — resolved ONCE per job from the
 * Project row plus the installation's paths, so none of them reads the global repository settings any more.
 * Pure (no I/O except `resolveWorkDir`, which stats the subdirectory) — tested in project-context.test.ts.
 */
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ProjectGitRef } from './git-credentials.port';
import { BRIEF_FILE, BRIEF_TEMPLATE, projectBriefTemplate } from '../workspace/workspace-core';
import { effectiveIsolation, isProjectKind, isRepoAuth, normalizeSubdir, type ProjectIsolation, type ProjectKind, type ProjectRepoAuth } from './project-core';

/** The columns of a Project row the context is built from. */
export interface ProjectContextRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  isDefault: boolean;
  repoUrl: string | null;
  repoBranch: string;
  repoSubdir: string | null;
  repoAuth: string;
  repoPath: string | null;
  isolation: string | null;
  verifyCommands: string | null;
  verifyMaxAttempts: number;
  defaultAgent: string | null;
  notifyChannelId: string | null;
  notifyChatId: string | null;
}

/** The installation paths and the mode the context depends on (a subset of AppConfigService). */
export interface ProjectContextPaths {
  workspaceRepoPath: string;
  workspaceDir: string;
  projectsDir: string;
  workspaceShared: boolean;
}

/** Global settings a project falls back to when it has no value of its own (§2.7: `Project.notify…` → `AppSettings`). */
export interface ProjectContextFallback {
  defaultAgent?: string | null;
  notifyChannelId?: string | null;
  notifyChatId?: string | null;
}

export interface ProjectContext {
  id: string;
  slug: string;
  name: string;
  kind: ProjectKind;
  isDefault: boolean;
  /** The checkout: `Project.repoPath` (the default project's WORKSPACE_REPO_PATH), else `<PROJECTS_DIR>/<slug>/repo`. */
  repoPath: string;
  repoUrl: string | null;
  repoBranch: string;
  /** Normalised subdirectory the agents work in ('' = the repo root). */
  repoSubdir: string;
  repoAuth: ProjectRepoAuth;
  /** What the project runs with: its own setting, else the installation's WORKSPACE_SHARED. */
  isolation: ProjectIsolation;
  /** One command per line, blank lines dropped. Empty for a docs project (nothing to verify). */
  verifyCommands: string[];
  verifyMaxAttempts: number;
  /** The project's folder (memory / work / deliverables / the brief): WORKSPACE_DIR for the default project, `<PROJECTS_DIR>/<slug>` otherwise. */
  workspaceRoot: string;
  /** The brief file in that folder (`WORKSPACE.md` for the default project, `PROJECT.md` for the others) and its untouched template. */
  briefFile: string;
  briefTemplate: string;
  /** Effective (project, else global). */
  defaultAgent: string | null;
  notifyChannelId: string | null;
  notifyChatId: string | null;
  /** What the git credentials port is asked with. */
  git: ProjectGitRef;
}

/** `verifyCommands` as stored (one per line) → the list to run. */
export function parseVerifyCommands(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split('\n')
    .map((c) => c.trim())
    .filter(Boolean);
}

/** The project's folder: the default project's is WORKSPACE_DIR, every other one lives under PROJECTS_DIR. */
export function projectDirOf(row: Pick<ProjectContextRow, 'slug' | 'isDefault'>, paths: Pick<ProjectContextPaths, 'workspaceDir' | 'projectsDir'>): string {
  return row.isDefault ? paths.workspaceDir : join(paths.projectsDir, row.slug);
}

/**
 * The project's checkout: the default project's is ALWAYS WORKSPACE_REPO_PATH (set by the environment, re-adopted at
 * boot — whatever an older row says); another project's is its `repoPath` when set, else `<dir>/repo`.
 */
export function projectRepoPathOf(row: Pick<ProjectContextRow, 'slug' | 'isDefault' | 'repoPath'>, paths: Pick<ProjectContextPaths, 'workspaceRepoPath' | 'projectsDir'>): string {
  if (row.isDefault) return paths.workspaceRepoPath;
  return row.repoPath ?? join(paths.projectsDir, row.slug, 'repo');
}

export function buildProjectContext(row: ProjectContextRow, paths: ProjectContextPaths, fallback: ProjectContextFallback = {}): ProjectContext {
  const kind: ProjectKind = isProjectKind(row.kind) ? row.kind : 'code';
  const auth: ProjectRepoAuth = isRepoAuth(row.repoAuth) ? row.repoAuth : 'none';
  const repoUrl = row.repoUrl?.trim() || null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind,
    isDefault: row.isDefault,
    repoPath: projectRepoPathOf(row, paths),
    repoUrl,
    repoBranch: row.repoBranch?.trim() || 'main',
    repoSubdir: normalizeSubdir(row.repoSubdir),
    repoAuth: auth,
    isolation: effectiveIsolation(row.isolation, paths.workspaceShared),
    verifyCommands: kind === 'code' ? parseVerifyCommands(row.verifyCommands) : [],
    verifyMaxAttempts: Math.max(0, row.verifyMaxAttempts ?? 2),
    workspaceRoot: projectDirOf(row, paths),
    briefFile: row.isDefault ? BRIEF_FILE : 'PROJECT.md',
    briefTemplate: row.isDefault ? BRIEF_TEMPLATE : projectBriefTemplate(row.name),
    defaultAgent: row.defaultAgent?.trim() || fallback.defaultAgent?.trim() || null,
    notifyChannelId: row.notifyChannelId?.trim() || fallback.notifyChannelId?.trim() || null,
    notifyChatId: row.notifyChatId?.trim() || fallback.notifyChatId?.trim() || null,
    git: { slug: row.slug, repoUrl, repoAuth: auth },
  };
}

/** Where a task's worktree goes in worktree mode: `WORKTREES_ROOT/<slug>/<taskId>` (§2.1). */
export function worktreePathFor(worktreesRoot: string, slug: string, taskId: string): string {
  return join(worktreesRoot, slug, taskId);
}

/** The branch a task works on in worktree mode. */
export const taskBranchFor = (taskId: string): string => `agent/task-${taskId}`;

/**
 * The agent's cwd inside a checkout: the configured subdirectory when it exists there, else the checkout root (a stale
 * setting must not wedge every task — the root stays the write boundary regardless). `warn` receives the reason for a fallback.
 */
export async function resolveWorkDir(root: string, subdir: string, warn?: (reason: string) => void): Promise<string> {
  if (!subdir) return root;
  const dir = join(root, subdir);
  try {
    if ((await stat(dir)).isDirectory()) return dir;
    warn?.(`repoSubdir "${subdir}" is not a directory — using the checkout root`);
  } catch {
    warn?.(`repoSubdir "${subdir}" not found in ${root} — using the checkout root`);
  }
  return root;
}

/**
 * Folders an agent may write to besides its task root (`LDS_EXTRA_WRITE_ROOTS`): the project's folder (memory / work /
 * deliverables, the brief) and — in shared mode — the checkout. In worktree mode the main checkout is NOT a write root:
 * the task's worktree is its checkout (§2.6). The task root itself is never repeated.
 */
export function extraWriteRootsFor(project: Pick<ProjectContext, 'workspaceRoot' | 'repoPath' | 'isolation' | 'kind'>, taskRoot: string): string[] {
  const roots = [project.workspaceRoot];
  if (project.kind === 'code' && project.isolation === 'shared') roots.push(project.repoPath);
  const task = resolve(taskRoot);
  return [...new Set(roots.map((r) => resolve(r)))].filter((r) => r !== task);
}

/** Where a docs project's tasks work: `work/` of the project folder (no git, §2.5). */
export function docsWorkDirOf(project: Pick<ProjectContext, 'workspaceRoot'>): string {
  return join(project.workspaceRoot, 'work');
}
