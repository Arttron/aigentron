# Browser through a proxy (`playwright-proxy`)

The normal `playwright` browser connects directly. For pages that are geo-blocked, tied to an IP, or reject the server's address there is a second browser service whose **whole traffic goes through a proxy you provide**. Agents pick it by using the `playwright-proxy` MCP server instead of `playwright` (see the playwright skill, `agent/skills/core/playwright.md`).

## Proxy connections in the dashboard (the easy way)
**Add-ons → Playwright → Browser proxy.** Paste the line the seller gave you (`res.proxy-seller.com;10000;user;pass`, `user:pass@host:port`, … — see below for every shape), give it a name, Save; **Test** shows which address sites see through it; pick the one the browser uses — or **Direct**. The choice applies at once (no restart) to the agents' ordinary `playwright` browser, for every task (it is one browser for the whole server). The login is kept in `secrets/proxies.json` (mode 0600) and is never shown again, never given to agents, and not in any API answer.

**Agents** can choose among the saved proxies by name: the tools `browser_proxy_list` / `browser_proxy_use` (see the playwright skill) — they get names and hosts only, never a login. The checkbox "Let agents choose a proxy for the browser" switches this off; the page says when an agent made the choice (and which task). Every switch closes the gateway's open connections so the browser reconnects through the new choice; the choice is one for the whole server, so an agent is told to put it back when it is done.

How it works: the Playwright browser always goes through the server's **gateway** (`proxies/gateway.ts`, port `PROXY_GATEWAY_PORT`, default 8940; on the Docker stack it listens on the internal network only, nothing is published on the host; off with `PROXY_GATEWAY_PORT=0`). The gateway forwards each connection to the chosen proxy, adding the login, or connects directly. Pages of the project's own preview servers and the stack's services (`PLAYWRIGHT_BROWSER_PROXY_BYPASS`) are reached by the browser itself, not through the gateway; the gateway refuses to connect to private or local addresses, so a page cannot use it to reach the server's network. HTTP / HTTPS proxies only (the seller's HTTP port); SOCKS is refused with the reason. The Docker `playwright-mcp` service points at `http://orchestrator:8940` by default; **bare-metal Playwright add-on** (the systemd service `aigentron-playwright`): from 0.1.127 the installer puts the gateway into the unit itself (`--proxy-server http://127.0.0.1:<PROXY_GATEWAY_PORT, 8940> --proxy-bypass localhost,127.0.0.1`; no flags when the gateway is off with `PROXY_GATEWAY_PORT=0`) — after updating, run `sudo aigentron addon enable playwright` once to rewrite the unit. On an older version, or to do it by hand: run `sudo systemctl edit aigentron-playwright` and put in it (the `ExecStart` line is the one from `systemctl cat aigentron-playwright`, with the two proxy options appended):
```
[Service]
ExecStart=
ExecStart=<the unit's own ExecStart line> --proxy-server http://127.0.0.1:8940 --proxy-bypass localhost,127.0.0.1
```
then `sudo systemctl restart aigentron-playwright` (once; later choices of proxy need no restart). On such a server the gateway listens on 127.0.0.1:8940. The `.env` routes below (`PLAYWRIGHT_BROWSER_PROXY`, the second `playwright-proxy` service) still work and are for a proxy that must be fixed in the stack's own configuration or for pages that must be direct and proxied in the same task.

## Setup (through `.env`)
1. Put the proxy in the server's **`.env`** (the secrets file next to `docker-compose.yml`; agents never see it). The simplest is ONE line, exactly as the proxy seller hands it out:
```
PLAYWRIGHT_PROXY=res.proxy-seller.com;10000;user;pass
# PLAYWRIGHT_PROXY_BYPASS=localhost,my-internal-host   # optional: hosts that skip the proxy
```
These shapes are all understood (`infra/proxy-parse.cjs`; the separators `;` `,` `|` tab or spaces work too, and the password may hold `:` or `@`):

| Written as | Means |
|---|---|
| `host;port;user;pass` | the seller's usual list line |
| `host:port:user:pass` | the same with colons |
| `user:pass@host:port` | login and password first |
| `host:port@user:pass` | host first |
| `http://user:pass@host:port` · `https://…` · `socks5://…` | a full address (login / password may be %-encoded) |
| `host:port` | a proxy without a login |
| `user:pass:host:port` | login first (told apart by where the port number is) |

The older separate variables still work, and win where both are set: `PLAYWRIGHT_PROXY_SERVER` (host:port, or any shape above), `PLAYWRIGHT_PROXY_USER`, `PLAYWRIGHT_PROXY_PASS`. A line that cannot be read stops the container with the reason (never printing the password). Chromium cannot log in to a **SOCKS** proxy: use the seller's HTTP(S) port when there is a login.
2. Start the service (it lives in its own compose profile, so nothing changes until you do):
```
docker compose --profile proxy up -d playwright-mcp-proxy
```
It listens on `playwright-mcp-proxy:8932` (also `127.0.0.1:8932` on the host) and is registered as the MCP server **`playwright-proxy`** (Settings → MCP servers — seeded automatically).
3. Give the agents that need it `playwright-proxy` in their `mcp:` list (Agents → Edit → MCP servers).
After changing the `.env` values: `docker compose --profile proxy up -d --force-recreate playwright-mcp-proxy`.

## The normal browser through a proxy too (no second browser)
Instead of (or as well as) the second service, the ordinary `playwright` browser can use a proxy: put `PLAYWRIGHT_BROWSER_PROXY=host;port;user;pass` (any shape above) in `.env` and recreate it: `docker compose --profile mcp up -d --force-recreate playwright-mcp`. Then ALL its traffic goes through the proxy except the hosts in `PLAYWRIGHT_BROWSER_PROXY_BYPASS` (default `localhost,127.0.0.1,orchestrator,project-dev,host.docker.internal,playwright-mcp,dashboard,postgres` — so `preview_worktree` and `project-dev` pages still open directly; add the host of any other local site you preview). Not set = a direct browser, exactly as before; a proxy line that cannot be read stops the container with the reason. Docker installs only: the bare-metal Playwright add-on has no proxy setting yet. Use the second service (`playwright-proxy`) when some pages must be direct and others proxied in the same task; use this when everything the browser does should go through the proxy.

## How it works
`infra/playwright-proxy-config.cjs` (with `infra/proxy-parse.cjs`) turns these variables (login and password are optional) into a Playwright MCP config (`browser.launchOptions.proxy` with `server`, `username`, `password`, `bypass`) when the container starts, so the credentials are only in `.env` and in the container's temp file (mode 600). A missing proxy stops the container with a clear message.

## Safety
- The browser is refused `file:`, `chrome:` and other non-http(s) addresses outright (not even an approval card), and the container's environment no longer holds the proxy login after start — a page cannot read it from `/proc/self/environ` or from a local file.
- Same approval rules as the normal browser: capture tools are free, and so are clicks and typing while the browser is on a local page; navigation to a non-local URL — and clicks and typing once the browser is on one — need approval; credentials are never given to agents (the skill tells them not to ask for or print them).
- The proxy sees the sites the browser visits (HTTPS content stays encrypted, host names do not). Use a proxy you trust; metered proxies are billed per use.
- The proxy browser cannot reach the project's own preview servers (`project-dev`, task previews) — use the normal browser for those.
- On bare-metal / minimal installs without compose, run the browser MCP yourself with `--config` pointing at a file with the same `launchOptions.proxy` shape and register it as an MCP server named `playwright-proxy`.
