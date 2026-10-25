# Moving to another server

Two commands: `aigentron export` on the old server, `aigentron import` on the new one. The export is a single archive with everything that cannot be rebuilt — and, unlike
a daily `aigentron backup`, the code too.

## What is in the archive

| carried | note |
|---|---|
| the database (tasks, transcripts, approvals, projects, agents' settings, schedules, knowledge bases, users) | a consistent SQLite snapshot, safe while the server runs. **Postgres is not included** (compose installs): `pg_dump "$DATABASE_URL" > aigentron.sql` and `psql` on the new one |
| `secrets/` | sign-in password, provider keys and logins (Codex, Claude), every project's deploy key / token / pinned host keys, channel tokens |
| agents, skills (core, custom, learned), resources, attachments | |
| the shared workspace and **every project's folder** (`projects/<slug>`: memory, library, work, deliverables) | (the backup before 0.1.86 missed `projects/` — update before relying on an old backup) |
| the code: the default project's `repo/`, every project's checkout and the agents' `worktrees/` | `aigentron export` adds them; `--no-repos` leaves them out. Without `node_modules`, build output and caches (rebuilt by one install). **Needed when a project has no remote** — a local-only repository exists nowhere else |
| a copy of the server's `.env` (bare-metal) | saved on the new server as `<data>/backups/env-from-backup.txt` |

**Not carried:** `runs/` and caches (rebuilt), the Claude conversation store (a task you continue starts a fresh conversation — it still has its transcript and files), the **add-ons**
(re-enable them) and the **Browser add-on's profile** (your own sign-ins stay on the old server on purpose), the LiteLLM generated config (regenerated).

## The move, step by step

**On the old server**

```sh
sudo aigentron export                                  # → ./aigentron-export-<time>.tar.gz   (0600)
sudo aigentron export --to ubuntu@new-host:/tmp/       # …and send it with scp (or copy it yourself)
```

Let running tasks finish first (or stop the service: `sudo aigentron stop`) — what is being written during the export may be half done. The archive holds your keys: move it over
SSH, keep it 0600, delete it afterwards.

**On the new server**

1. Install Aigentron — the **same or a newer version** (an archive made by a newer version is refused: its database has migrations the older one does not know; `--force` overrides).
   Use the same data folder (`/opt/aigentron/data` by default): task rows store absolute paths to their worktrees, and the import warns when the folder differs.
2. `sudo aigentron import /tmp/aigentron-export-<time>.tar.gz` — asks to confirm, stops the service, puts everything back (what it replaces is kept in
   `<data>/backups/before-restore-<time>`), starts the service.
3. Check: `aigentron status`, `aigentron doctor`, the dashboard (Tasks, Projects, Settings).

**Then, on both**

- **Stop the old server** (`sudo aigentron stop`, and disable it) once the new one works. Two servers must not share one **Telegram bot** (a bot token polls from one place) or push to the
  same repositories.
- On the new server: **re-enable the add-ons** (`sudo aigentron addon enable browser` / `playwright`); sign in again in the browser add-on.
- **`.env`**: copy what you need from `env-from-backup.txt` (domains, `PUBLIC_URL`, API keys set there, `AGENT_*` limits). Settings → Access / Cloudflare Access: the **domain names** of the
  old server do not exist on the new one — check them before you lock yourself out (`aigentron access`).
- Agent isolation (`aigentron harden`) was a property of the old server: run it again on the new one if you used it.
- Projects with a remote repository fetch by themselves at the next task (Projects → settings → **Test** checks the access: the deploy keys moved with `secrets/`; a host that had them
  registered sees the same key from a new IP, which is fine).

## When something does not fit

- *"made by version X, newer than the installed Y"* — update the new server first (`aigentron update`), or `--force` if you know the database is compatible.
- *The data folder differs* — tasks that had worktrees need a fresh start (their finished results are in the transcript and the project folder); put the new data in the old path to avoid this.
- *A big archive* — `--no-repos` and push the code to its remotes instead, then let each project clone itself.

## Where it lives

`infra/backup.sh` (the archive and restore; `--with-repos`, the version guard, the data-dir warning), `infra/aigentron-cli.sh` (`export`, `import`, `backup`, `restore`).
Shell tests in throw-away Debian and Alpine containers: `sh scripts/test-infra.sh` (needs Docker).
