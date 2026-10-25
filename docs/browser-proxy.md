# Browser through a proxy (`playwright-proxy`)

The normal `playwright` browser connects directly. For pages that are geo-blocked, tied to an IP, or reject the server's address there is a second browser service whose **whole traffic goes through a proxy you provide**. Agents pick it by using the `playwright-proxy` MCP server instead of `playwright` (see the playwright skill, `agent/skills/core/playwright.md`).

## Setup
1. Put the proxy in the server's **`.env`** (the secrets file next to `docker-compose.yml`; agents never see it):
```
PLAYWRIGHT_PROXY_SERVER=proxy.example.com:3128     # endpoint:port  (or a full URL: http://…, socks5://…)
PLAYWRIGHT_PROXY_USER=your-login                    # optional, with the password
PLAYWRIGHT_PROXY_PASS=your-password
# PLAYWRIGHT_PROXY_BYPASS=localhost,my-internal-host   # optional: hosts that skip the proxy
```
2. Start the service (it lives in its own compose profile, so nothing changes until you do):
```
docker compose --profile proxy up -d playwright-mcp-proxy
```
It listens on `playwright-mcp-proxy:8932` (also `127.0.0.1:8932` on the host) and is registered as the MCP server **`playwright-proxy`** (Settings → MCP servers — seeded automatically).
3. Give the agents that need it `playwright-proxy` in their `mcp:` list (Agents → Edit → MCP servers).
After changing the `.env` values: `docker compose --profile proxy up -d --force-recreate playwright-mcp-proxy`.

## How it works
`infra/playwright-proxy-config.cjs` turns these variables (login and password are optional) into a Playwright MCP config (`browser.launchOptions.proxy` with `server`, `username`, `password`, `bypass`) when the container starts, so the credentials are only in `.env` and in the container's temp file (mode 600). A missing `PLAYWRIGHT_PROXY_SERVER` stops the container with a clear message.

## Safety
- The browser is refused `file:`, `chrome:` and other non-http(s) addresses outright (not even an approval card), and the container's environment no longer holds the proxy login after start — a page cannot read it from `/proc/self/environ` or from a local file.
- Same approval rules as the normal browser: capture tools are free, and so are clicks and typing while the browser is on a local page; navigation to a non-local URL — and clicks and typing once the browser is on one — need approval; credentials are never given to agents (the skill tells them not to ask for or print them).
- The proxy sees the sites the browser visits (HTTPS content stays encrypted, host names do not). Use a proxy you trust; metered proxies are billed per use.
- The proxy browser cannot reach the project's own preview servers (`project-dev`, task previews) — use the normal browser for those.
- On bare-metal / minimal installs without compose, run the browser MCP yourself with `--config` pointing at a file with the same `launchOptions.proxy` shape and register it as an MCP server named `playwright-proxy`.
