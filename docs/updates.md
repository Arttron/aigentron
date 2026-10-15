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
