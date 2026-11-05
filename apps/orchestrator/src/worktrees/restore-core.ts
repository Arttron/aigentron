/**
 * A task whose checkout was cleared (finished work, see maintenance/finished-work.ts) and that gets a new message needs its folder back. If its branch still
 * exists the folder is made again from it — the person continues exactly where the work was; if the branch is gone (its work was merged and it was deleted
 * with the checkout) the caller makes a fresh checkout from the base branch.
 */
export interface RestoreDeps {
  /** run `git <args>` in the project's main repository */
  git: (args: string[]) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  /** is the folder a git checkout (a worktree of the repository)? */
  isCheckout?: (path: string) => Promise<boolean>;
}

export type RestoreResult = 'present' | 'restored' | 'branch-missing';

/** The folder exists but git does not know it as a checkout (left by a half-failed removal, or a plain folder): the agent must not be started in it. */
export class NotACheckoutError extends Error {}

export async function restoreWorktree(d: RestoreDeps, worktreePath: string, branch: string): Promise<RestoreResult> {
  if (await d.exists(worktreePath)) {
    if (d.isCheckout && !(await d.isCheckout(worktreePath))) throw new NotACheckoutError(`The folder ${worktreePath} exists but is not a git checkout (a leftover?). Remove it, then continue the task: its checkout will be made again from its branch.`);
    return 'present';
  }
  // forget the registration of the folder that is gone, or git refuses to put a worktree on the same branch / path again
  await d.git(['worktree', 'prune']).catch(() => undefined);
  const hasBranch = await d.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
  if (!hasBranch) return 'branch-missing';
  try {
    await d.git(['worktree', 'add', worktreePath, branch]);
  } catch (e) {
    const why = (e as Error).message.split('\n').find((l) => /already|checked out|used by/i.test(l)) ?? (e as Error).message.split('\n')[0] ?? '';
    throw new Error(`Could not bring the checkout back: its branch ${branch} is in use elsewhere (${why.slice(0, 200)}). Close the other checkout of that branch and continue the task.`);
  }
  return 'restored';
}
