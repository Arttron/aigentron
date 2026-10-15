import { execFile } from 'node:child_process';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentIsolation } from '@lds/agent-runner';

const pexec = promisify(execFile);

/** The OS user agents run as (S-01); `null` = not configured, agents run as the orchestrator's own user. */
export interface AgentRunAs {
  uid: number;
  gid: number;
}

/**
 * `AGENT_RUN_AS_UID` (+ optional `AGENT_RUN_AS_GID`, default = uid) from the env.
 * Unset/empty → null (today's behaviour). Set but invalid (not a positive integer,
 * root) → throws, so a typo cannot silently leave agents running as root.
 */
export function parseAgentRunAs(env: Record<string, string | undefined>): AgentRunAs | null {
  const rawUid = env.AGENT_RUN_AS_UID?.trim();
  if (!rawUid) return null;
  const id = (name: string, raw: string): number => {
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer (got "${raw}")`);
    const n = Number(raw);
    if (n <= 0) throw new Error(`${name} must not be 0 — agents must never run as root`);
    return n;
  };
  const uid = id('AGENT_RUN_AS_UID', rawUid);
  const rawGid = env.AGENT_RUN_AS_GID?.trim();
  return { uid, gid: rawGid ? id('AGENT_RUN_AS_GID', rawGid) : uid };
}

/** One step of the per-run ownership pass. */
export interface ChownStep {
  path: string;
  /** `chown -R` (a tree the agent writes into) vs. the directory itself only. */
  recursive: boolean;
  /** Create it first (mode = `mode`) — directories the orchestrator provides for the agent. */
  mkdir?: boolean;
  mode?: number;
  /** Skip silently when it does not exist (e.g. no Codex run yet). */
  optional?: boolean;
  /** `false`: only mkdir/chmod, keep root as the owner (the run dir: settings.json with the hook lives there). */
  chown?: boolean;
}

export interface ChownPlanInput {
  /** <agentDir>/runs/<taskId> */
  runDir: string;
  /** The task's checkout; null for a chat agent / discussion turn (they only read). */
  worktreePath: string | null;
  /** WORKSPACE_REPO_PATH — the main repo (holds `.git` of every worktree). */
  repoPath: string;
  /** Shared-workspace mode: the task works directly in the main repo. */
  shared: boolean;
  workspaceDir: string;
  attachmentsDir: string;
}

/**
 * What must belong to the agent user before a run (pure; applied by the service):
 *   - its HOME (+tmp) under the run dir — settings.json beside it stays root's,
 *   - the Codex per-run home when there is one,
 *   - the shared workspace and the task's attachments,
 *   - the checkout: the whole repo in shared mode; in worktree mode the worktree
 *     AND the main repo's `.git` (a worktree's index/refs/objects live there).
 * Files root created in between (verification, preview, fetch) are re-owned on
 * the next run — the per-run pass is what keeps the agent able to write.
 */
export function chownPlan(p: ChownPlanInput): ChownStep[] {
  const home = join(p.runDir, 'home');
  const steps: ChownStep[] = [
    { path: p.runDir, recursive: false, mkdir: true, mode: 0o755, chown: false },
    { path: home, recursive: true, mkdir: true, mode: 0o700 },
    { path: join(home, 'tmp'), recursive: false, mkdir: true, mode: 0o700 },
    { path: join(p.runDir, 'codex-home'), recursive: true, optional: true },
    { path: p.workspaceDir, recursive: true, mkdir: true, mode: 0o755 },
    { path: p.attachmentsDir, recursive: true, mkdir: true, mode: 0o755 },
  ];
  if (p.worktreePath) {
    if (p.shared || p.worktreePath === p.repoPath) steps.push({ path: p.repoPath, recursive: true });
    else steps.push({ path: join(p.repoPath, '.git'), recursive: true, optional: true }, { path: p.worktreePath, recursive: true });
  }
  return steps;
}

/** The runner's isolation params for a run. Pure. */
export function isolationFor(runAs: AgentRunAs, wrapper: string, runDir: string): AgentIsolation {
  return { uid: runAs.uid, gid: runAs.gid, wrapper, home: join(runDir, 'home') };
}

/** Execute a plan: mkdir/chmod where asked, then chown (recursively for trees) unless the step keeps root as the owner. */
export async function applyChownPlan(plan: ChownStep[], runAs: AgentRunAs): Promise<void> {
  for (const step of plan) {
    if (step.mkdir) {
      await mkdir(step.path, { recursive: true, mode: step.mode });
      if (step.mode !== undefined) await chmod(step.path, step.mode);
    } else if (step.optional && !(await stat(step.path).catch(() => null))) {
      continue;
    }
    if (step.chown === false) continue;
    const owner = `${runAs.uid}:${runAs.gid}`;
    await pexec('chown', step.recursive ? ['-R', owner, step.path] : [owner, step.path]).catch((err) => {
      throw new Error(`could not hand ${step.path} to the agent user: ${(err as Error).message}`);
    });
  }
}
