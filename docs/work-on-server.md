# Working on a project's code directly on the server

You want to edit the code **on the server** (over SSH, VS Code Remote-SSH, JetBrains Gateway …), run it and test it there, while the agents work on the
same repository. This page says where the code is, how to connect your own directory, and — the part that matters — how not to get in each other's way.

## Where the code lives

| | path (bare-metal / minimal install; `<data>` = `/opt/aigentron/data` unless you chose another) | Docker install |
|---|---|---|
| the **default** project's checkout | `WORKSPACE_REPO_PATH` = `<data>/repo` | `/workspace/repo` (inside the volume) |
| any **other** project's checkout | `<data>/projects/<slug>/repo` (`PROJECTS_DIR` = `<data>/projects`) | `<PROJECTS_DIR>/<slug>/repo` in the volume |
| the agents' worktrees (worktree mode) | `<data>/worktrees/<slug>/<task id>` | `WORKTREES_ROOT/<slug>/<task id>` |

The exact checkout path of a project is `repo.path` in `GET /api/projects/<slug>`. The service runs as **root** on a bare-metal install (agents too, unless you
ran `aigentron harden`, which runs them as another user), so these folders belong to root.

## Two modes decide everything: `shared` and `worktree`

Set per project: **Projects → the project → settings → Isolation** (empty = follow the server default; the minimal install starts in `shared`).

- **`shared`** — every task of the project runs **in the checkout itself**, one at a time, on whatever branch is checked out there; when a run finishes, the orchestrator
  pushes **the current branch** to the project's `origin` (no pull request). Simple, but **not safe to share with a person**: if you are on your own branch in that folder, the
  agent's commits land on your branch and are pushed.
- **`worktree`** — each task gets its own branch `agent/task-<id>` and its own folder under `<data>/worktrees/…`, made from `origin/<branch>`; the result is a pull request (with a
  token) or a branch to merge. The checkout itself is **not touched** apart from `git fetch` and the bookkeeping `git worktree add` leaves in `.git`.

**Rule: if you work in a directory the project uses, set that project to `worktree`.** If you cannot, work in your own clone (way 1) — the safest.

## Way 1 — your own clone on the server (recommended)

Nothing is shared except the remote. You keep your tree, the agents keep theirs.

```sh
# as your own user on the server
git clone git@github.com:acme/shop.git ~/shop        # or your usual remote
cd ~/shop && git switch -c feature/x                  # work, test, commit, push as always
```

- The project in Aigentron points at the same remote (Projects → settings → Repository). Agents' branches (`agent/task-…`, or pushed through `push_branch`) arrive there; you
  `git fetch` and look at or merge them. Your pushes reach the agents at their next sync (`origin/<branch>` is fetched before every task).
- **No GitHub?** Make a bare repository on the server and use it as the common remote: `git init --bare /srv/git/shop.git`; clone it for yourself, and give the project the
  URL `file:///srv/git/shop.git` (access **none**; the URL must have the `file://` form, a bare path is not accepted). The service (root) can read it; make it writable by you: `sudo chown -R $USER /srv/git/shop.git`.
- Your push key is yours (`~/.ssh`). The project's deploy key (Aigentron's own) is only for the orchestrator — see `docs/projects.md`.

## Way 2 — work in the project's own checkout

Only with the project set to **`worktree`** (above). Then:

```sh
CHECKOUT=/opt/aigentron/data/projects/<slug>/repo      # or the default project's <data>/repo
sudo chown -R "$USER": "$CHECKOUT"                      # you own it now; the service (root) can still use it
git config --global --add safe.directory "$CHECKOUT"    # git refuses a folder of another owner otherwise ("dubious ownership")
cd "$CHECKOUT" && git switch -c feature/x
```

- **Agent isolation on** (`aigentron harden`, agents run as another user): that user must be able to write the checkout in `shared` mode and the worktrees in `worktree` mode — give a
  common group instead of `chown`: `sudo groupadd -f aigentron-dev; sudo usermod -aG aigentron-dev $USER; sudo chgrp -R aigentron-dev "$CHECKOUT"; sudo chmod -R g+rwX "$CHECKOUT";
  sudo find "$CHECKOUT" -type d -exec chmod g+s {} +; git -C "$CHECKOUT" config core.sharedRepository group` (log out and in for the group).
- Keep the **checkout on the project's branch** (`main`) when you are not working: the agents' worktrees are made from `origin/<branch>`, not from your working tree, so your
  uncommitted files are never in their work — and theirs are never in yours.
- The sync (before each task and "Sync now") runs `git fetch --prune origin <branch>` and sets `origin` to the project's repository URL. It never resets, pulls, checks out or
  cleans — your changes are safe — but **if your `origin` differs from the URL in the project's settings, it is rewritten**. Keep them equal.

## Way 3 — make the project use a clone you already have (default project only)

The default project adopts `WORKSPACE_REPO_PATH` at every start (it is "whatever the environment says"):

```sh
sudo systemctl edit aigentron          # bare-metal / minimal install; add the two lines below, save
#   [Service]
#   Environment=WORKSPACE_REPO_PATH=/home/ubuntu/shop
sudo systemctl restart aigentron
```

(A drop-in survives updates; the unit file itself is rewritten by every update.) On a Docker install mount your folder into the container and set `WORKSPACE_REPO_PATH` in `.env` to the
mount path. Then the same rules as Way 2 apply — set the project to `worktree` — plus the ownership steps for that folder. Other projects always use `<data>/projects/<slug>/repo`:
to start from a clone you made, clone it **there** (as root, or `chown` it back) before the first task — the sync sees a repository and only fetches.

## Testing your changes on the server

- Run the app in your tree as you always do (`npm run dev`, a service of your own …). To open it from your laptop: `ssh -L 3000:localhost:3000 you@server`, then
  `http://localhost:3000`.
- VS Code: *Remote-SSH* to the server and open your folder — the terminal, debugger and port forwarding are the server's.
- The agents' own preview of **their** work is separate (`preview_worktree`, ports 3200–3203 — see `agent/skills/core/playwright.md`; with the Playwright add-on `localhost`).
  Keep your dev server off those ports.

## Bringing the agents' work into yours

```sh
git fetch --all --prune
git branch -r | grep agent/                    # agent/task-<id> — one branch per task (worktree mode)
git log --oneline origin/main..origin/agent/task-<id>
git merge origin/agent/task-<id>               # or open the pull request the task shows
```

In `shared` mode there are no task branches: the agent's commits are on the branch that was checked out and have been pushed to `origin/<that branch>`.

## Do not

- **Do not leave a project on `shared` while you work in its checkout** (see the rule above).
- Do not run `git reset --hard`, `git clean` or `git checkout .` in the checkout while a task of that project is running.
- Do not commit `.env`, keys or `<data>/secrets` — the agents' protected-path rules refuse those, but your own commits are yours.
- Do not publish the dev server's port (3000, 3200–3203) on a public interface; use the SSH tunnel.

## When something fails

- `fatal: detected dubious ownership in repository` → the `git config --global --add safe.directory <path>` line above, for the user that runs git.
- A task says it cannot fetch → Projects → the project → settings → **Test** (it names the failing step); `docs/projects.md`.
- Agents cannot write in the folder → the permissions of Way 2 (group or owner); `aigentron harden` is what runs agents as another user; `aigentron doctor` shows the state.
