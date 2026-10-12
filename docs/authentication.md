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
| Agent-facing routes (`/api/approvals/check`, `/api/approvals/:id/wait`, `/api/internal-mcp`, `/api/research-mcp`) | no session, but each has its own credential (hook secret / per-run token) **and only answers calls from this machine** (loopback), so a public tunnel cannot reach them |
| `/api/mcp` (outside MCP clients) | its own `MCP_TOKEN`; without one it needs a session |
| `/api/secret-links/<token>` | open on purpose: the one-time token **is** the credential — it can only set the single value a pending secret request asked for (write-only, works once, expires in 10 minutes, kept in memory) |
| `/api/health`, `/api/auth/status`, `/login`, `/setup`, `/logout` | open (health check, sign-in); the other `/api/auth/*` routes (password, sessions) need a session |

Wrong passwords are rate-limited (5 misses, then a growing wait up to 15 minutes, per client address).

## Console (`aigentron-admin` / `make admin`)

Asks who you are (a numbered list, skipped when only one user has a password) and the password (hidden), then keeps a session token
in `~/.local/state/aigentron/admin-session.json` (mode 0600). For scripts set `LDS_ADMIN_USER` (name) and `LDS_ADMIN_PASSWORD`.

## Signed-in devices (sessions)

Settings → **Signed-in devices** tab lists every browser or device that is signed in: which one (e.g. "Chrome on macOS"), from which address, when it signed in and when it was last
active, with **Sign out** for each. You see your own; an **operator or admin sees everybody's** and can sign anyone out. Ending a session signs that device out at once.
- **Sign out my other devices** — ends all your other sessions, this browser stays signed in.
- Operators/admins: **Sign … out everywhere** ends all sessions of one person (their password stays).
- **Changing or resetting a password ends all of that person's sessions** (when you change your own, this browser stays signed in). Removing a password does too.
- "Sign out other browsers" under Security (everyone's) still exists; it ends every session of everyone.
The addresses shown are the real client addresses (behind a tunnel the connecting proxy is trusted for `cf-connecting-ip`, see `TRUSTED_PROXY`). **Logging out ends the session on the server too** (the dashboard's Sign out and `aigentron logout`), so it disappears from the list and the old cookie stops working. The terminal (`aigentron`, `aigentron admin`) keeps ONE
session in `~/.local/state/aigentron/admin-session.json` (mode 0600) and reuses it, so running it again does not add a new device each time; if that session was ended or expired it signs in again.
Sessions signed in before this feature
keep working until they expire, but are not listed.

## Forgot the password

Someone else (an operator/admin) can reset it in Settings → Users. If it is the only operator, `make reset-password` (or delete
`secrets/auth.json` on the server) removes **all** passwords: sign-in turns off until you set the first one again.
Changing your password signs your other browsers out; "Sign out other browsers" (everyone's) does that without changing it.

## Where it lives

`<secrets dir>/auth.json` (mode 0600): a scrypt hash per user and the key that signs session cookies. It sits in the
credentials directory that the approval gate already guards, outside the agent tree. No database change.

## Honest limits

- Agents run on the same machine as the orchestrator. The sign-in stops them using the HTTP API, but an agent that is allowed to
  read `secrets/auth.json` (the approval gate asks you first) or to reach the database directly could still tamper with state.
  Real isolation = running agents as a separate OS user / container — see `docs/BACKLOG.md`.
- The login screen shows the users' names and roles to anyone who can open the page. If that matters, keep the page behind Cloudflare Access (`docs/remote-access.md`).
- Roles are enforced on the routes that declare them: tasks, approvals, questions, discussions, users, channels, maintenance, stats, providers, resources, schedules, packs, knowledge bases, voice, media, updates, task titles, domains / web server / Cloudflare Access (mostly operator/admin; creating tasks and answering questions also task setter / reviewer). General settings, agents and MCP servers are open to every signed-in user for now.
- The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when served over HTTPS (also behind a tunnel). Use HTTPS for any non-local access
  (see `docs/remote-access.md`); over plain HTTP on an open network the password travels in clear text.
