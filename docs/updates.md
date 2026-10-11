# Updating the server

Releases are published on GitHub. Three ways to update, all keep your data, settings and passwords:

- **Dashboard:** Settings → General → *Version & updates* — shows the installed and the newest version with the release notes; **Update to X** (an operator confirms).
- **Admin assistant:** asks `update_status`, tells you what is new, then proposes the update; you approve the card (`propose_update`).
- **Terminal:** `sudo aigentron update` (also works for a Docker install, which cannot update itself from the dashboard).

How it works (bare-metal install): the server writes a small script that downloads the **target release's** installer and runs it detached from the service (a transient
systemd unit), because the installer restarts the service. The new release is built next to the running one; only when it is ready does the `current` link switch and the service
restart (about a minute or two — the dashboard reconnects by itself). The **previous release is kept**: `sudo aigentron rollback` goes back to it (database changes of the newer
version are additive and harmless). The outcome and the installer's log are in `<data>/update/` and shown in the dashboard after a failure.

Safeguards: only an operator/admin can start it; it refuses while tasks are running or queued unless you confirm they may be interrupted; it needs ~1.5 GB of free disk; the version is
validated (`0.1.48`, never a free-form string) and only newer versions are accepted. Switch it off with `UPDATE_ENABLED=0` in `.env`. `UPDATE_REPO` (default `Arttron/aigentron`)
sets where releases come from.

A Docker install cannot replace its own container: the dashboard still shows that a newer version exists, and says to run `aigentron update` on the server.
