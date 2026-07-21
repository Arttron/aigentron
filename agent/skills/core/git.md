---
name: git
description: Commit message format, branch naming, and git workflow conventions for this team. Use when writing commit messages, creating branches, or describing git operations.
---

# Skill: Git
**Applies to:** all coder agents, PM, Architect

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

```
main       — production
develop    — integration branch
feature/   — feature/user-profile
fix/       — fix/login-error
hotfix/    — hotfix/payment-crash
```

## Workflow

```bash
# Start a task
git checkout develop
git pull origin develop
git checkout -b feature/task-name

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
git fetch origin
git rebase origin/develop
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

## Authentication — do NOT look for a token

Pushing/fetching to `origin` is **already authenticated** for you: the GitHub token is baked into
the repo's git config (`http.extraHeader`). So:

- Just run plain git — `git push origin HEAD:main`, `git fetch origin` — it authenticates itself.
- **Do NOT search for a token** in env vars, `.env`, files, or `gh auth`. There is none in your
  environment by design, and you do not need one. A missing `$GITHUB_TOKEN` / `gh` login is
  EXPECTED — it is not an error and not a "network problem".
- If a git remote command fails, read the actual error: `403 Write access not granted` = the
  token lacks permission (a human must fix the token), NOT a network issue. Report precisely.

## Reminder

`git push` (any remote/branch), `git merge`, and any force operation are classified as dangerous
by the runtime and require human approval — so a push pauses for approval, then proceeds. (The
orchestrator also pushes automatically when a task finishes, so pushing yourself is usually
unnecessary unless the task explicitly asks for it.)
