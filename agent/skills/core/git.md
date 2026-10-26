---
name: git
description: Git in a project - commit messages, branch naming, and the remote (fetch_remote to fetch / pull, push_branch to push: agents hold no credentials, so git fetch / pull / push from the shell fail). Use for any git operation, especially pulling, fetching, pushing or a remote error such as Host key verification failed.
---

# Skill: Git
**Applies to:** all coder agents, PM, Architect

---

## You work inside a project

Every task belongs to one project, and its settings apply to you: repository and base branch, how the remote is reached, `shared` or `worktree` isolation, the subdirectory you work in, and the
verification commands the orchestrator runs after you. They are listed in your system prompt under **The project's settings** — read them before you plan git work instead of guessing
(do not change the remote, the branch or credentials yourself; the project's settings are a person's to change). The rest of this skill assumes them.

## Pushing: use `push_branch`, never `git push`

You have no credentials and no SSH key — a `git push` from the shell always fails (`Host key verification failed`, `could not read Username`).
Do not retry it, do not look for keys, do not ask for a token. Commit on a LOCAL branch, then call the tool `push_branch {branch, to?, reason}`:
`to` is the branch name on the remote (default: the same; e.g. publish `develop` as `main` into an empty repository). A person approves every
push; it is never forced. The orchestrator pushes with the project's own key. Finished runs are also published by the orchestrator (task
branch / pull request), but only the branch of that task — work you merged into another branch needs `push_branch`.

---

## Commit message format

```
type(scope): short description (max 72 chars)

[optional] Longer explanation of what changed and why — not how.

[optional] Closes #123
```

### Types
| Type | When to use |
|------|-------------|
| `feat` | New functionality |
| `fix` | Bug fix |
| `refactor` | Refactor without behavior change |
| `test` | Adding/changing tests |
| `chore` | Tooling, dependencies, config |
| `docs` | Documentation |
| `style` | Formatting, no logic change |
| `perf` | Performance improvement |
| `ci` | CI/CD changes |

### Scope — module or feature name
```
feat(auth): add refresh token rotation
fix(users): handle null email on registration
refactor(posts): extract pagination to shared utility
chore(deps): update nestjs to v10.3
```

## Branches

The project's base branch and isolation mode (your system prompt, **The project's settings**) decide where you are: in `worktree` mode you already stand on your own branch
`agent/<short-title>-<id6>` (e.g. `agent/fix-login-button-6yvhs1`; `agent/task-<id>` when the title gives nothing) made from `origin/<base branch>` — stay on it, do not create or switch branches unless the task asks (the orchestrator publishes that branch when you finish);
in `shared` mode you work on the branch checked out in the project, and your commits stay on it. The names below are the team's convention for branches you are *asked* to create;
`main` / `develop` here are examples — the project's own base branch wins.

```
main       — production
develop    — integration branch
feature/   — feature/user-profile
fix/       — fix/login-error
hotfix/    — hotfix/payment-crash
```

## Workflow

```bash
# Start a task: you are already on the right branch (see above). Look, do not switch:
git status
git branch --show-current
# need newer commits of the base branch?  call fetch_remote, then:  git merge origin/<base branch>

# Work
git add .
git commit -m "feat(scope): description"

# Finish — commit locally, do NOT push yourself.
# push / PR / merge are gated behind review + explicit human confirmation.
```

## Common commands

```bash
git diff HEAD
git status
git reset --soft HEAD~1     # undo last commit, keep changes
# fetch_remote (the tool), then:
git rebase origin/<base branch>
git stash / git stash pop
git log --oneline -10
```

## GitHub operations (via the `github` MCP server)

Local git — branch, commit, diff, log (the shell commands above) — stays on the CLI: there is no
"git MCP" and none is needed. **GitHub-side** operations, for agents that have `github` in their
`mcp:` list, go through `mcp__github__*` rather than raw `gh`/curl:

- Read an issue or PR referenced by the task (context, acceptance criteria).
- Search code across the repository host.
- Check the status / comments of an existing PR.
- **Monitor CI / GitHub Actions** — the `actions_*` read tools list workflow runs,
  jobs, and logs (e.g. `mcp__github__actions_list` with method `list_workflow_runs`,
  then `get_workflow_run`, `get_job_logs`). Poll a run's status with these directly.
  You do **NOT** need a GitHub token, `GH_TOKEN`, the `gh` CLI, or a cron job — the
  MCP is already authenticated server-side. If `github` isn't in your `mcp:` list,
  say so and report `blocked`; don't ask the human for a token.
  - **To wait for a run to finish, use the `schedule_check` tool** — don't say "I'll
    check back in 2 minutes" (your run ends and won't resume itself). Call
    `schedule_check` with `delaySeconds` and a note; you'll be re-run to poll again,
    and can re-schedule until the run concludes. Then report the final result.

You do **not** open or merge PRs yourself. On a successful, verified run the orchestrator pushes
the branch and opens the PR for you. Use the `github` MCP to *read* context and *report* what you
find — not to push or merge.

> Read verbs (`get_*`, `list_*`, `search_*`) run without approval; anything that mutates
> (`create_*`, `update_*`, `merge_*`, `push_*`, `add_*`, `delete_*`) is approval-gated. Use the
> reads for context you actually need, not as a substitute for the task description you have.

## Fetching and pulling: use `fetch_remote`, never `git fetch` / `git pull`

Your shell has no credentials for the remote, so `git fetch` / `git pull` / `git ls-remote` from Bash fail (`Host key verification failed`, `Permission denied`) — that is expected, not a
fault to fix: do not retry, do not look for keys, do not ask for a token or report "blocked". Call the tool `fetch_remote {branch?}` (default: the project's branch; `all` = every branch).
The orchestrator fetches with the project's key and `origin/<branch>` becomes current; none of your files or branches change. Then bring the commits in with plain git
(`git merge origin/<branch>` or `git rebase origin/<branch>`). No approval is needed. A task starts from an up-to-date `origin/<branch>` already, so call it only when asked to pull or when
you need commits that arrived while you work.

## Authentication — do NOT look for a token

You hold no credentials for the remote, by design:

- Remote commands from your shell (`git push`, `git fetch`, `git pull`, `git ls-remote`) do NOT authenticate: use `push_branch` and `fetch_remote` (above). Local git (commit, merge, rebase, log, diff) is plain git.
- **Do NOT search for a token** in env vars, `.env`, files, or `gh auth`. There is none in your environment by design, and you do not need one. A missing `$GITHUB_TOKEN` / `gh` login is
  EXPECTED — it is not an error and not a "network problem".
- If `push_branch` or `fetch_remote` reports a failure, read its message: `Permission denied` / `403 Write access not granted` = the project's key or token lacks the permission
  (a person must fix it under the project's Repository settings), NOT a network issue. Report it precisely and report `blocked` — do not try to work around it.

## Reminder

`push_branch` always waits for a person's approval (unless approvals are switched off for the task); `fetch_remote` and local git do not. Force operations (`--force`, `reset --hard` on shared
history) are classified as dangerous by the runtime. The orchestrator also publishes your task's branch when it finishes, so pushing yourself is usually unnecessary unless the task explicitly asks for it.
