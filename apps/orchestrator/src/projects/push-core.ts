/**
 * Which refs an agent may ask the orchestrator to push (`push_branch`). The agent never holds the project's credentials: it names a
 * LOCAL branch and the branch it should become on the remote; a person approves each push; the orchestrator pushes with the
 * project's key/token. Pure: no git, no I/O.
 */

export type PushRefs = { ok: true; branch: string; to: string } | { ok: false; message: string };

const SAFE = /^[A-Za-z0-9._/-]{1,120}$/;

/** A branch name that is safe to put on a git command line and in a refspec (no options, no odd refs, no `..`). */
export function isSafeBranchName(name: string): boolean {
  if (!SAFE.test(name)) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('/.') || name.includes('@{')) return false;
  if (name === 'HEAD' || name.startsWith('refs/')) return false;
  return true;
}

/** `branch` is the local branch, `to` (default: the same name) the branch on the remote. */
export function parsePushRefs(branch: unknown, to: unknown): PushRefs {
  const b = typeof branch === 'string' ? branch.trim() : '';
  const t = typeof to === 'string' && to.trim() ? to.trim() : b;
  if (!b) return { ok: false, message: 'Refused: give the local branch to push (e.g. "develop").' };
  if (!isSafeBranchName(b)) return { ok: false, message: `Refused: "${b}" is not a plain branch name (letters, digits, . _ - /; not HEAD, not refs/…).` };
  if (!isSafeBranchName(t)) return { ok: false, message: `Refused: "${t}" is not a plain branch name for the remote.` };
  return { ok: true, branch: b, to: t };
}
