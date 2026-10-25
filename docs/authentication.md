# Sign-in (a password per user)

Everyone who uses the dashboard has their **own password**. The login screen lists the users and you pick your name and type
the password — no login names, no e-mail, nothing to host. The user's **role** (operator / admin / reviewer / task_setter) decides
what they may do; the session — not any header — decides who is acting.

## Turning it on

- **First password (normal way):** a banner asks "Set password" while none exists (also Settings → General → **Security**).
  It becomes the **default operator's** password (8–200 characters). You stay signed in on that browser for 30 days (`AUTH_SESSION_DAYS`).
- **More people:** Settings → **Users** → 🔑 *Set password* for each user (operator/admin only). They are listed on the login screen
  from then on. A user without a password cannot sign in. Resetting someone's password signs them out everywhere.
- **Your own password:** Settings → General → Security → *Change my password*. At least one operator/admin must always keep a password.
- **Headless install:** set `ADMIN_PASSWORD` in `.env` before the first start; it is applied once (for the default operator) when no
  password exists yet (you can remove it afterwards). Installs with the earlier single password are migrated to the default operator automatically.
- **Fresh `install.sh`** (never on an existing install): right after the first start it sets a random operator password through `POST /api/auth/setup` on localhost, prints it once and saves it to
  `<data>/secrets/initial-password.txt` (0600). `NO_INITIAL_PASSWORD=1` skips this. Change it in Settings → Security (then delete the file).
- Until a password exists nothing changes: the instance is open, and a warning is logged at startup.
  **Set it right after updating**, especially if the dashboard is reachable from outside.

## Allowed domains (Settings → General → Access)

A second, separate control: **which domain names the server answers to**. Add the name you publish it under (`dev.example.com`, or `*.example.com`);
anything else gets `421`. Empty list = no restriction (the behaviour before this existed); `PUBLIC_URL`'s host counts as listed.
`localhost`, IP addresses and single-word names are **always** accepted — port forwarding, `ssh -L`, opening by IP and the local network are never affected,
and the page refuses a list that would cut off the address you are using right now. It is stored in `<secrets dir>/access.json`.
This limits *where* the page opens; *who* may use it is decided by the passwords above — or by Cloudflare Access (`docs/remote-access.md`),
which is an alternative to the built-in passwords and also works as an extra layer.

## What it protects

| Path | With a password set |
|---|---|
| Dashboard and every `/api/*` route | needs a valid session (cookie, or `Authorization: Bearer <token>`) |
| Live updates (Socket.IO) | only a signed-in browser may connect |
| Approval verdicts, settings, agents, providers, MCP servers, secrets entry | same session — **an agent can no longer approve itself over HTTP** |
| Agent-facing routes (`/api/approvals/check`, `/api/approvals/:id/wait`, `/api/internal-mcp`, `/api/research-mcp`) | no session, but each has its own credential (hook secret / per-run token; for `/api/research-mcp` the per-run token is enforced once `LDS_RESEARCH_MCP_REQUIRE_TOKEN=1`) **and only answers calls from this machine** (loopback), so a public tunnel cannot reach them |
| `/api/mcp` (outside MCP clients) | its own `MCP_TOKEN`; without one it needs a session |
| `/api/secret-links/<token>` | open on purpose: the one-time token **is** the credential — it can only set the single value a pending secret request asked for (write-only, works once, expires in 10 minutes, kept in memory) |
| `/api/health`, `/api/auth/status`, `/login`, `/setup`, `/logout` | open (health check, sign-in); the other `/api/auth/*` routes (password, sessions) need a session |

Wrong passwords are rate-limited (5 misses, then a growing wait up to 15 minutes, per client address).

## Console (`aigentron-admin` / `make admin`)

Asks who you are (a numbered list, skipped when only one user has a password) and the password (hidden), then keeps a session token
in `~/.local/state/aigentron/admin-session.json` (mode 0600). For scripts set `LDS_ADMIN_USER` (name) and `LDS_ADMIN_PASSWORD` (and `LDS_ADMIN_TOTP` when the account uses two-factor sign-in).

## Signed-in devices (sessions)

Settings → **Signed-in devices** tab lists every browser or device that is signed in: which one (e.g. "Chrome on macOS"), from which address, when it signed in and when it was last
active, with **Sign out** for each. You see your own; an **operator or admin sees everybody's** and can sign anyone out. Ending a session signs that device out at once.
- **Sign out my other devices** — ends all your other sessions, this browser stays signed in.
- Operators/admins: **Sign … out everywhere** ends all sessions of one person (their password stays).
- **Changing or resetting a password ends all of that person's sessions** (when you change your own, this browser stays signed in). Removing a password does too.
- "Sign out other browsers" under Security (everyone's) still exists; it ends every session of everyone.
The addresses shown are the real client addresses (the connecting proxy is trusted for `cf-connecting-ip` when it is loopback, the `cloudflared` container, a Cloudflare edge address, or listed in `TRUSTED_PROXY` - IPs or CIDRs; `TRUST_CLOUDFLARE=0` disables the built-in Cloudflare ranges). Failed sign-ins are limited per address (5 free) and per account (15 free, up to 15 min wait). **Logging out ends the session on the server too** (the dashboard's Sign out and `aigentron logout`), so it disappears from the list and the old cookie stops working. The terminal (`aigentron`, `aigentron admin`) keeps ONE
session in `~/.local/state/aigentron/admin-session.json` (mode 0600) and reuses it, so running it again does not add a new device each time; if that session was ended or expired it signs in again.
Sessions signed in before this feature
keep working until they expire, but are not listed.

## Two-factor sign-in (authenticator app)

Optional, per user. Each person turns it on for themselves, once: Settings → General → Security → **Two-factor sign-in → Turn on**. Confirm with your password, scan the QR (or open the link on the phone, or type the key) in
any TOTP app (Google / Microsoft Authenticator, 1Password, Aegis …), type the code it shows, and save the **ten recovery codes** (shown once; each works one time instead of a code).
From then on the sign-in asks for the password and then a 6-digit code. Details:

- **Required for a user:** an operator/admin ticks *Require two-factor sign-in* when adding or editing the user (Settings → Users). That person's next sign-in does not open the app: it shows the QR code, and the first code they type turns it on and signs them in (the recovery codes are shown then). They cannot turn it off themselves; **Reset 2FA** (lost phone) makes them set it up again at the next sign-in. The console tells such an account to sign in once in the dashboard first.
- A code works once (the same one is refused a second time) and a minute of clock drift is tolerated. Wrong codes count towards the same attempt limits as wrong passwords.
- Turning it off, or making new recovery codes, needs the password **and** a code — a stolen session alone cannot remove it. Changing the password keeps it.
- Lost phone: use a recovery code, or an operator/admin presses **Reset 2FA** for that user in Settings → Users (they are signed out everywhere and can set it up again).
- Console / scripts: the console asks for the code; set `LDS_ADMIN_TOTP` to the current code for a non-interactive run (`LDS_ADMIN_PASSWORD` as before). API: `POST /api/auth/login` answers `401 {needsCode: true}` after a right password; send the same request again with `code`.
- It lives in `secrets/auth.json` with the password hashes (the TOTP secret is stored there in the clear, like the session-signing key: the file is mode 0600 and closed to agents). `make reset-password` removes it with the passwords.

## Forgot the password

Someone else (an operator/admin) can reset it in Settings → Users. If it is the only operator, `make reset-password` (or delete
`secrets/auth.json` on the server) removes **all** passwords: sign-in turns off until you set the first one again.
Changing your password signs your other browsers out; "Sign out other browsers" (everyone's) does that without changing it.

## Where it lives

`<secrets dir>/auth.json` (mode 0600; read through a ~2 s cache, so a manual edit or `make reset-password` takes effect within a couple of seconds, a change made by the server itself at once): a scrypt hash per user (and the two-factor secret and recovery-code hashes of those who turned it on) and the key that signs session cookies. It sits in the
credentials directory that the approval gate guards and that agent isolation (below) closes to agents by OS permissions, outside the agent tree. No database change.

## Routes and roles

| Routes | Who may call (with sign-in on, or as the acting user when it is off) |
|---|---|
| `PUT /api/settings`, `POST /api/settings/verify-wizard-password` (rate-limited), `POST/PUT/DELETE /api/agents`, `POST/PUT/DELETE /api/providers`, `POST /api/providers/models-preview`, `POST /api/providers/:name/test`, `/api/mcp-servers` (changes), `POST /api/update/check`, `POST /api/update/apply` | operator, admin |
| Task changes: create, subtasks, start, done, follow-up, cancel, delete, pending follow-ups (edit / remove), attachment upload | task setter, operator, admin |
| Viewing (all `GET`), approving, answering questions | any signed-in user, including reviewer |

Without a sign-in password the request is attributed to the default operator (or to the user in the `x-lds-user` header), so the owner's own setup is unaffected.
A reviewer or task setter who tries a route above gets 403. `apps/orchestrator/src/identity/roles-coverage.test.ts` fails when a mutating handler of these controllers has no `@Roles`.

## Agents on their own OS user (agent isolation)

Agents (the Claude CLI, Codex and everything they start — shells, MCP servers, the approval hook) can run as a separate,
unprivileged OS user while the orchestrator keeps running as root. It is switched on by `AGENT_RUN_AS_UID` (+ `AGENT_RUN_AS_GID`,
default = uid) in the environment: **it is OFF by default; `AGENT_ISOLATION=1` at install time or `sudo aigentron harden` turns it on** (user `agent`, uid/gid 1500);
an existing install turns it on with **`sudo aigentron harden`** (Docker: re-creates the container with the new env; bare-metal:
in place + restart); the dev Compose stack leaves it off unless you set the variable yourself. Unset = today's behaviour, agents
run as the orchestrator's user.

What it changes:
- The orchestrator starts the runtime through `infra/agent-exec.sh`, which drops to the agent uid with
  `setpriv --reuid --regid --clear-groups --no-new-privs` (the SDK's `pathToClaudeCodeExecutable` points at the wrapper; Codex is
  spawned through it). The agent's `HOME`/`TMPDIR` are `<agent dir>/runs/<task>/home` (its session files live there, so a follow-up
  of a task started BEFORE the switch begins a fresh conversation).
- `infra/harden.sh` (run by the container entrypoint on **every** start, by the installer and by `aigentron harden`) creates the user,
  sets `secrets/` 0700, the SQLite database (+wal/shm) 0600, `litellm-config.generated.yaml` 0600, `backups/` 0700 and the `.env`
  0600, hands `repo/`, `worktrees/*`, `workspace/`, `agent/attachments/`, `runs/*/{home,codex-home}` to the agent user, whitelists
  agent-owned checkouts for root's git (`safe.directory=*`), and finally **checks, as the agent user, that the secrets dir and the
  database cannot be read** and that the hook, `packages/shared/dist` and the Claude binary can. Before each run the orchestrator
  re-applies ownership of the task's own directories (the checkout — in worktree mode the worktree plus the main repo's `.git` —, the
  workspace, this task's attachments, its home), so files the verification gate or a `git fetch` created as root never block the agent.
- **Fail closed:** when the variable is set but the wrapper, `setpriv`, the user or the permissions are wrong, the orchestrator logs
  the reason at start and every agent run ends with that error — it never silently falls back to running as root.

What the approval gate does and does not protect: with agent isolation **on**, `secrets/` (session-signing key, password hashes,
the Codex sign-in, TLS keys), the database and `.env` are protected by OS permissions — a shell command that evades the classifier
gets "permission denied". The classifier/approval gate stays as a guard rail against risky actions inside what the agent CAN reach
(the project, the workspace, the network). With isolation **off**, the gate is the only thing between an agent and those files, and
it is a deny-list of patterns, not a boundary.

Still shared with isolation on: the agent user is one for all tasks (a run can read another run's `codex-home`), the hook secret and
the orchestrator's local HTTP port are in the agent's reach (the sign-in cookie is not — it only grants `approvals/check|wait`).

**Repository credentials** (tokens, SSH deploy keys, pinned host keys) are files under `<secrets dir>/projects/<slug>/` — 0700 /
0600, read by the orchestrator only and handed to its own git as environment, never to agents (the project sync writes
nothing into a checkout's `.git/config`). How to set them up per project, add a deploy key on GitHub / GitLab / Bitbucket and test the access:
[docs/projects.md](projects.md).

## Honest limits

- Agents run on the same machine as the orchestrator. The sign-in stops them using the HTTP API. **Without agent isolation** (see
  above) an agent that is allowed to read `secrets/auth.json` (the approval gate asks you first) or to reach the database directly
  could still tamper with state; with it on, those files are closed to the agent by the OS.
- The login screen shows the users' names and roles to anyone who can open the page. If that matters, keep the page behind Cloudflare Access (`docs/remote-access.md`).
- Roles are enforced on the routes that declare them (see "Routes and roles" below). Roles apply to HTTP routes only; Telegram and other channel users act through the services and are not affected.
- The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when served over HTTPS (also behind a tunnel). Use HTTPS for any non-local access
  (see `docs/remote-access.md`); over plain HTTP on an open network the password travels in clear text.
