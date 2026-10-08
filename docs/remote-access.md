# Remote access to the dashboard (Cloudflare Tunnel + Access)

Goal: open the dashboard from a laptop or phone over HTTPS **without opening any port on the server**.

> **Read this first.** The API and dashboard have **no built-in login yet** (planned, see `docs/BACKLOG.md`). Whoever reaches
> the page is the operator: they can approve agent actions, start tasks and change settings. So the public hostname **must**
> be protected by an authenticating layer — Cloudflare Access below — before you share the link or open it to anyone.

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
3. **Access → Applications → Add an application → Self-hosted**: the same hostname, a policy **Allow** for your e-mail(s)
   or your identity provider (Google/GitHub/one-time e-mail code). Set a session length you are comfortable with.
   Make the policy cover the **whole hostname** (not just `/`).
4. Free plan covers up to 50 Access users.

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

It adds that origin to the allowed origins and prints a reminder at startup that the API has no login of its own.
It is advisory; it does not open anything.

## Things to know

- **Everything under the hostname is behind Access** — including `/api/mcp` (the MCP entry point for outside clients),
  `/api/internal-mcp` and `/api/research-mcp`. Browsers pass through Access fine; a non-browser MCP client would need an
  Access *service token* or a separate bypass rule for `/api/mcp` (keep `MCP_TOKEN` set if you do that).
- **Access is the only gate** until built-in auth exists. Agents run on the same machine and can still reach the orchestrator on
  `localhost` (see the "API authentication and agent isolation" item in `docs/BACKLOG.md`); that is independent of how you expose it.
- Postgres, Redis, LiteLLM and the research/playwright services are **not** exposed by the tunnel; keep their ports on `127.0.0.1`.
- The "acting user" switcher in the dashboard only labels who did something; it is not authentication.
- Using something else (Tailscale, your own reverse proxy with SSO)? Point it at `orchestrator:3001`, forward WebSocket upgrades for
  `/socket.io`, and set `PUBLIC_URL`. Nothing else in the app depends on Cloudflare.

## Troubleshooting

- Page loads but nothing updates → WebSocket blocked: check the hostname's Access policy covers `/socket.io` and no WAF rule blocks upgrades.
- Blank page / 404 → the dashboard bundle is missing: `make build-dashboard`.
- `cloudflared` restarts with a token error → `TUNNEL_TOKEN` is empty or wrong in `.env`.
