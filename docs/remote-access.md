# Remote access to the dashboard (Cloudflare Tunnel + Access)

Goal: open the dashboard from a laptop or phone over HTTPS **without opening any port on the server**.

## Two ways to protect public access — pick one, or use both

| | **A. Built-in** (default, nothing to sign up for) | **B. Cloudflare Access** (alternative, or an extra layer) |
|---|---|---|
| What it does | Passwords per user (`docs/authentication.md`) + a list of **allowed domains** (Settings → General → Access) | Cloudflare asks visitors to sign in (Google / GitHub / e-mail one-time code) **before** your server sees them |
| Who is let in | People with a password for this server | People you list in the Access policy |
| Second factor | No (use a long passphrase) | Yes, effectively — the e-mail/identity provider |
| The login page is visible to | anyone who can reach the address (names and roles are listed there) | nobody until they pass Cloudflare |
| Works without Cloudflare | yes — any tunnel, VPN or port forward | no |
| Setup | set passwords, optionally the domain list | a free Zero Trust application (5 minutes, steps below) |

**Recommended for anything public:** A *and* B. If you only want one: A is enough for a private instance behind an unguessable passphrase;
B is the better choice when the page will be opened from many places or shared with a team, because it also hides the login page.
A random sub-domain is *not* a security measure on its own (names leak through DNS and certificate logs) — it only reduces noise.

**What the server decides on its own:** with a domain list (or `PUBLIC_URL`) set, it answers only to those names. `localhost`, IP addresses
and single-word names (a LAN host, a docker service) are **always** accepted, so opening the server by IP, an SSH tunnel
(`ssh -L 3011:localhost:3011 server`) or a plain port forward works exactly as before — you can never lock yourself out of your own machine.
The server cannot tell *who* is behind a domain — that is what the passwords (A) or Cloudflare Access (B) are for.

> Set the passwords (`docs/authentication.md`) *before* exposing anything: without them whoever reaches the page is the operator.

## How it fits together

```
phone / laptop ──HTTPS──▶ Cloudflare (Access login) ──tunnel──▶ cloudflared ──▶ orchestrator:3001
                                                                              ├─ /            dashboard (built SPA, same origin)
                                                                              ├─ /api/*       REST API
                                                                              └─ /socket.io   live updates (WebSocket)
```

- `cloudflared` only makes an **outbound** connection to Cloudflare. Ports stay bound to `127.0.0.1` (`BIND_ADDRESS`).
- The orchestrator serves the dashboard itself on its own port, so there is **one origin** (no CORS, no extra proxy).
- Do **not** point the tunnel at the Vite dev port (`3000`/`3088`): that dev server talks to the API on another origin.

## One-time Cloudflare setup (about 10 minutes)

1. Cloudflare dashboard → **Zero Trust** → **Networks → Tunnels → Create a tunnel** (type *Cloudflared*). Copy the **token**.
2. In the tunnel → **Public Hostname**: hostname `dev.your-domain.com`, service type **HTTP**, URL `orchestrator:3001`
   (for the bare-metal install use `localhost:3001`). WebSockets work without extra settings.
3. *(Way B — optional but recommended)* **Access → Applications → Add an application → Self-hosted**: the same hostname, a policy **Allow**
   for your e-mail(s) or your identity provider (Google/GitHub/one-time e-mail code). Set a session length you are comfortable with.
   Make the policy cover the **whole hostname** (not just `/`). Free plan: up to 50 Access users.
4. *(Way A)* In the dashboard: Settings → General → **Access**, add `dev.your-domain.com` (or set `PUBLIC_URL`, which adds it automatically).

## Start it (dev / docker compose)

In `.env`:

```
TUNNEL_TOKEN=<token from step 1>
PUBLIC_URL=https://dev.your-domain.com
```

Then:

```
make tunnel-up        # builds the dashboard bundle the orchestrator serves, starts the stack + cloudflared
```

After you change the dashboard code run `make build-dashboard` (the orchestrator serves the built bundle, not the dev server).

Minimal / bare-metal: install `cloudflared` on the host (`cloudflared service install <token>`) and use `localhost:3001` as the origin.

## What `PUBLIC_URL` does

It adds that origin to the allowed origins, **adds its host to the allowed domains** (so only that name — plus local access — is served), and,
if no dashboard password is set yet, prints a loud warning at startup and shows a red banner in the dashboard. It does not open anything.

## Make the server check Cloudflare Access itself (optional)

Cloudflare Access alone protects the hostname *if* every request really goes through it. To make the server enforce that, give it the two values of your Access
application — **Settings → General → Cloudflare Access** in the dashboard, or `aigentron access` → *Cloudflare Access* in a terminal on the server:

- **Team domain** — Zero Trust → Settings → *Team domain* (`yourteam.cloudflareaccess.com`);
- **Application Audience (AUD) tag** — Access → Applications → your application → *Overview*.

With it on, a request that arrives under a real domain name must carry Cloudflare's signed `Cf-Access-Jwt-Assertion` token (checked against Cloudflare's published keys:
signature, issuer, audience, expiry). A tunnel hostname that has no Access policy, or a direct hit on the origin with the public `Host`, is answered `403`. The same check
guards the live-update WebSocket. `localhost`, IP addresses and single-word LAN names are never affected, so you cannot lock yourself out; the dashboard also refuses to switch
this on while *you* are connected through a public name without a valid token. If Cloudflare's keys cannot be fetched the request is refused (fail closed). The password
sign-in still applies on top. The **Test** button (and the terminal) show whether the keys can be fetched and — when opened on your public address — who Access says you are.
The setting is stored in `secrets/cloudflare-access.json`.

## Address settings in `.env`

`aigentron access` also shows the two address settings that live in the server's `.env` and need a restart: `PUBLIC_URL` (your public address) and
`ORCHESTRATOR_HOST` (`127.0.0.1` = listen on this machine only, e.g. behind a tunnel; default `0.0.0.0`). On a bare-metal install the terminal edits `.env` for you; on Docker it prints the lines to add.

## Things to know

- **Everything under the hostname is behind Access** — including `/api/mcp` (the MCP entry point for outside clients),
  `/api/internal-mcp` and `/api/research-mcp`. Browsers pass through Access fine; a non-browser MCP client would need an
  Access *service token* or a separate bypass rule for `/api/mcp` (keep `MCP_TOKEN` set if you do that).
- **Two layers (A and B above):** Cloudflare Access (who may reach the hostname) and the built-in passwords + domain list (who may use the app). The agent-facing
  routes only answer from the same machine, so the tunnel never exposes them.
- Postgres, Redis, LiteLLM and the research/playwright services are **not** exposed by the tunnel; keep their ports on `127.0.0.1`.
- The "acting user" switcher in the dashboard only labels who did something; it is not authentication.
- Using something else (Tailscale, your own reverse proxy with SSO)? Point it at `orchestrator:3001`, forward WebSocket upgrades for
  `/socket.io`, and set `PUBLIC_URL`. Nothing else in the app depends on Cloudflare.

## Troubleshooting

- Page loads but nothing updates → WebSocket blocked: check the hostname's Access policy covers `/socket.io` and no WAF rule blocks upgrades.
- Blank page / 404 → the dashboard bundle is missing: `make build-dashboard`.
- `cloudflared` restarts with a token error → `TUNNEL_TOKEN` is empty or wrong in `.env`.
