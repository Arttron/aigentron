import type { ProjectContext } from '../projects/project-context';
import { redactUrl } from '../worktrees/git-auth';

/** What the run can ask the orchestrator to do on the project's remote (the tools are wired only for a code project with a remote). */
export interface RemoteTools {
  fetch: boolean;
  push: boolean;
}

type Facts = Pick<ProjectContext, 'name' | 'slug' | 'isDefault' | 'kind' | 'repoUrl' | 'repoBranch' | 'repoSubdir' | 'repoAuth' | 'isolation' | 'verifyCommands' | 'verifyMaxAttempts'>;

const ACCESS: Record<string, string> = {
  none: 'none (a public repository: reading works, pushing does not)',
  token: "an HTTPS token held by the orchestrator (project settings → Repository)",
  ssh: "an SSH deploy key held by the orchestrator (project settings → Repository)",
};

/**
 * The project's own settings as the agent should know them: which repository and branch it works against, how the remote is reached (and that the
 * agent holds no credentials), the isolation mode, the verification the orchestrator runs afterwards. Short and static for a task, so it sits in the cached system block.
 */
export function projectFacts(p: Facts, tools: RemoteTools): string[] {
  if (p.kind !== 'code') return [];
  const lines = ['### The project\'s settings (you work inside this project; its rules apply to you)'];
  if (p.repoUrl) {
    lines.push(`- repository: \`${redactUrl(p.repoUrl)}\`, base branch \`${p.repoBranch}\`${p.repoSubdir ? `, you work in the subdirectory \`${p.repoSubdir}\`` : ''}`);
    lines.push(`- remote access: ${ACCESS[p.repoAuth] ?? p.repoAuth}. **You hold no credentials**: \`git push\`, \`git fetch\`, \`git pull\` and \`git ls-remote\` from your shell fail (\`Host key verification failed\`, \`Permission denied\`) — that is by design, not a fault: never retry them, never look for keys or tokens, never ask for one.`);
    const via = [tools.fetch ? '`fetch_remote` (download new commits, no approval; then `git merge origin/<branch>`)' : '', tools.push ? '`push_branch` (publish a local branch, a person approves)' : ''].filter(Boolean);
    if (via.length) lines.push(`- remote work goes through the orchestrator: ${via.join('; ')}. Local git (commit, branch, merge, rebase, log, diff) is plain git. Skill: \`git\`.`);
  } else {
    lines.push('- no remote repository is configured: the repository is local only (nothing to fetch or push).');
  }
  lines.push(
    p.isolation === 'shared'
      ? '- isolation: **shared** — tasks run one at a time in the project checkout itself; your commits land on the checked-out branch.'
      : `- isolation: **worktree** — your own branch and folder, made from \`origin/${p.repoBranch}\`; the checkout is not touched. The orchestrator publishes your branch when the task is done.`,
  );
  if (p.verifyCommands.length) lines.push(`- verification the orchestrator runs after your work (up to ${p.verifyMaxAttempts} attempt${p.verifyMaxAttempts === 1 ? '' : 's'}; a failure is sent back to you): ${p.verifyCommands.map((c) => `\`${c}\``).join(', ')}. Make these pass; run them yourself first.`);
  else lines.push('- verification: none configured for this project.');
  return lines;
}
