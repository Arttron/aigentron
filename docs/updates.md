# Updating the server

Releases are published on GitHub. Three ways to update, all keep your data, settings and passwords:

- **Dashboard:** Settings → General → *Version & updates* — shows the installed and the newest version with the release notes (**Check now** asks GitHub again); **Update to X** (an operator confirms).
- **Admin assistant:** asks `update_status`, tells you what is new, then proposes the update; you approve the card (`propose_update`).
- **Terminal:** `sudo aigentron update` (also works for a Docker install, which cannot update itself from the dashboard).

How it works (bare-metal install): the server writes a small script that downloads the **target release's** installer and runs it detached from the service (a transient
systemd unit), because the installer restarts the service. The new release is built next to the running one; only when it is ready does the `current` link switch and the service
restart (about a minute or two — the dashboard reconnects by itself). The **previous release is kept**: `sudo aigentron rollback` goes back to it. The outcome and the installer's log are in `<data>/update/` and shown in the dashboard after a failure.

Database safety: before `prisma migrate deploy` the installer takes a consistent snapshot of the SQLite database (`VACUUM INTO <data>/backups/pre-<version>.db`, the last 3 are kept; `sqlite3` if installed, otherwise the project's own better-sqlite3). If the migration fails, the snapshot is restored and the previous release keeps running. `aigentron rollback` offers to restore `pre-<current version>.db` (the data as the previous release last saw it; everything written since is discarded, and the replaced database is kept as `backups/before-rollback-<version>.db`) — answer no to keep the current data. Docker installs take the same snapshot in the container entrypoint (`/data/backups`) and exit with a clear message if the migration fails. Postgres deployments are not snapshotted — use `pg_dump`. An update whose status stays `running` for more than 30 minutes (the updater was killed) is reported as `failed` and no longer blocks a new update. In Docker mode the old container is stopped gracefully (`docker stop -t 60`) before it is replaced.

Safeguards: only an operator/admin can start it; it refuses while tasks are running or queued unless you confirm they may be interrupted; it needs ~1.5 GB of free disk; the version is
validated (`0.1.48`, never a free-form string) and only newer versions are accepted. Switch it off with `UPDATE_ENABLED=0` in `.env` (the admin's `propose_update` is bare-metal only too; where the data and releases live: `docs/workspace-layout.md`). `UPDATE_REPO` (default `Arttron/aigentron`)
sets where releases come from.

A Docker install cannot replace its own container: the dashboard still shows that a newer version exists, and says to run `aigentron update` on the server.

## Update sequence, health check and automatic rollback (bare-metal)

`install.sh` now works in this order: download the archive and **verify it against `SHA256SUMS`** of the release (GitHub release asset `SHA256SUMS`, or `releases/X.Y.Z/SHA256SUMS` next to the S3 archive; a mismatch stops the install
before anything is extracted; a release without SHA256SUMS only warns - `REQUIRE_CHECKSUM=1` makes it fatal; `ARCHIVE_SHA256=<hex>` pins a hash for a custom `ARCHIVE_URL`) -> build next to the running release -> **stop** the service -> database **snapshot** -> **migrate** -> switch `current` -> **start** ->
wait up to `HEALTH_TIMEOUT` (120 s) for `/api/health`. If the new release does not become healthy, the installer stops it, restores the pre-update database snapshot, points `current` and the unit back at the previous release and starts it; the update is reported `failed`. Old release directories
are removed only after the new one proved healthy (before the build only when less than 3 GB is free). The dashboard/`aigentron update` fetch the installer at the release **tag** (not `main`) and, when SHA256SUMS lists `install.sh`, check it too.
The updater uses `DATA_DIR` (not "parent of the secrets dir") for its state.

**Agent isolation on an existing install.** Updating never changes whether agents run as their own OS user: that is decided by
`AGENT_RUN_AS_UID` in the install's `.env` (fresh installs since this version have it; older ones do not). To switch an existing
install over run `sudo aigentron harden` — it writes `AGENT_RUN_AS_UID/GID=1500` into the `.env`, creates the `agent` user, sets the
modes on `secrets/`, the database and `.env`, hands the repo/workspace/attachments to that user and restarts (Docker: re-creates the
container; the entrypoint then re-applies `infra/harden.sh` on every start, so a restore or a volume copied from elsewhere is fixed
up automatically). Follow-ups of tasks started before the switch begin a fresh agent conversation. To go back: remove the two
lines from the `.env` and restart / re-run the installer with `FORCE=1`. Details: `docs/authentication.md`.

On every start the server reconciles what the previous process left behind: pending approvals and questions become `timeout`, tasks parked in `needs_approval` become `stalled` (resumable by a follow-up), so nothing waits forever and a late "Approve" cannot revive a task with no agent.

**Publishing a release (maintainers):** the release workflow must attach `SHA256SUMS` to the GitHub release with lines `<sha256>  v<version>.tar.gz` (the tag archive) and `<sha256>  install.sh`, and (S3) `releases/<version>/SHA256SUMS` with `<sha256>  archive.tar.gz`. `release.yml` does this (step "Publish SHA256SUMS"): it hashes the public repo's tag archive exactly as `install.sh` downloads it.

## Backup and restore

`sudo aigentron backup [file]` writes ONE archive (default `<data>/backups/aigentron-backup-<time>.tar.gz`, mode 0600, the 7 newest kept): the database (a consistent SQLite snapshot via `VACUUM INTO`, safe while the server runs),
`secrets/`, `agent/{agents,skills,learned,resources,attachments}` + `agent/research.json`, `workspace/`, and (bare-metal) a copy of the `.env` with your API keys. **Not included:** `runs/` and the caches (rebuilt), the project checkout `repo/` (a git clone - push your work), `backups/` itself.
Docker: `aigentron backup [file]` runs it in the container and copies the archive to the host (the host `.env` is not included - keep it yourself). Copy archives off the server; a backup on the same disk does not survive losing the disk.

`sudo aigentron restore <file>` stops the server, puts everything back (what it replaces is moved to `<data>/backups/before-restore-<time>/`, the old `.env` is saved as `backups/env-from-backup.txt`, never overwritten) and starts it. To restore onto a clean instance: install, then `aigentron restore`. Restored files are root's; with agent isolation on, the next start's `harden.sh` hands them back to the agent user.

Daily timer (off by default): `sudo aigentron backup-timer on` (03:30, `systemd`), `... off` removes it. Without systemd or on Docker use cron, e.g. `30 3 * * * /usr/local/bin/aigentron backup /backups/aigentron-$(date +\%F).tar.gz`.

**Postgres** (dev/full profile) is not part of the archive: `docker compose exec postgres pg_dump -U <user> <db> > aigentron.sql` and restore with `psql`.
The LiteLLM routes file is now `<data>/litellm-config.generated.yaml` (inside the data dir; it is regenerated from the settings at start).

## If the update fails half-way (bare-metal)
The server is stopped at the start of the switch. Since 0.1.73 the installer (a) refuses to start the switch when `/opt/aigentron`, the data dir or `/etc/systemd/system` has less than 300 MB free — the running version is left alone — and (b) if anything fails after the stop (a full disk, a failed step) it brings the previous release back up: the previous release and unit file, and the database from the pre-update snapshot if migrations had already run. The unit file is written next to the real one and moved into place, so a full disk never leaves a truncated unit. Before 0.1.73 a failure after the migration step left the service stopped: `sudo aigentron restart` starts it again.

Build caches (pnpm store, npm, corepack, `XDG_CACHE_HOME`) are kept in `<data dir>/cache` (`CACHE_DIR=<path>` to change it) since 0.1.73, so they follow the data directory you put on the big volume, and are cleaned after a successful update (`pnpm store prune`). Before, they went to the home directory of the user running the installer (`/root/.cache`, `/root/.npm`) — on a server with a small root disk and the install on another volume that filled `/` during an update.
