# Add-ons

An **add-on** is an optional piece of software the server installs next to Aigentron on request — bigger than a skill, outside the app
itself. Each one lives in `infra/addons/<name>/` and is managed with one command:

```
sudo aigentron addon enable browser          # install + start (idempotent: re-running changes nothing)
aigentron addon status browser               # state.json + are the endpoints answering (no root needed)
aigentron addon logs browser                 # follow its log (journalctl / docker logs)
sudo aigentron addon disable browser         # stop + remove the services; the profile/data is kept
sudo aigentron addon disable browser --purge # ...and remove the profile, the add-on's user and files too
aigentron addon list                         # what this release ships, and what is enabled
```

`enable` takes `--dry-run` (prints the plan, changes nothing), `--backend bare|docker`, and add-on specific options (for the browser:
`--browser chrome|chromium|playwright`, `--no-cdp`). A **Docker install** always runs add-ons as separate containers; an **autonomous
(bare-metal) server** installs them on the host as systemd units — or, with `--backend docker`, as a container with its ports published on
loopback. Both paths run the **same installer script** (`infra/addons/<name>/bare.sh`): the Docker image is built by executing it inside
`debian:12`, so there is one code path to maintain and test.

The first (and in stage 1 the only) add-on is the **browser**: a real Chromium on a virtual display that a person watches and operates from
the dashboard (`🌐 Browser`) and that agents drive over the Chrome DevTools Protocol. There is no general desktop — only the browser window.

## The Playwright add-on (a browser for the agents)

`sudo aigentron addon enable playwright` (bare-metal servers; on a Docker install the same MCP server is the compose profile `mcp`) gives the agents'
`playwright` MCP server a place to run when there is no compose: a headless Chromium behind **@playwright/mcp** (version pinned in `infra/addons/playwright/bare.sh`,
it brings its own matching Chromium), as one systemd unit `aigentron-playwright.service`, listening on `127.0.0.1:8931` only.

It is deliberately **not** the `browser` add-on. That one is a real, visible browser with a profile a person signs in to (and becomes part of the personal assistant);
this one is a throw-away headless browser — `--isolated`, no profile is kept between sessions — that agents may drive freely.

- **Install**: Debian 11+ and Ubuntu 22.04+ (apt; versions newer than Debian 13 / Ubuntu 24.04 are tried with a warning and the browser self-test decides), Amazon Linux 2023, Fedora (dnf), x86_64 or aarch64. Packages (Chromium's libraries), Node ≥ 18 (NodeSource if missing),
  `npm install @playwright/mcp` and `playwright install chromium` into `/opt/aigentron/playwright`, the system user `aigentron-playwright`, the unit, then checks: the
  server answers on `/sse`, and Chromium starts as that user. Re-running repairs; `--dry-run` prints the plan; `--files-only` installs the files without a unit (image builds, tests).
- **Unit**: own user, read-only system (`ProtectSystem=strict`), `PrivateTmp`, loopback only (`--host 127.0.0.1`, DNS-rebinding guard `--allowed-hosts`), `MemoryMax=1536M`,
  `OOMScoreAdjust=500` (a memory shortage costs this browser first). `--no-sandbox`: Chromium's own sandbox needs user namespaces, which Ubuntu 24.04 and hardened kernels refuse
  to an ordinary user; the boundary is the unit.
- **Orchestrator**: reads `<data>/addons/playwright/state.json`; while the add-on is enabled the `playwright` MCP server entry points at `http://127.0.0.1:8931/sse` (disabled → back
  to the compose address; an address a person typed is never changed), and `preview_worktree` hands out `localhost` URLs (`PREVIEW_PUBLIC_HOST` overrides).
- **Memory**: a page open in Chromium takes 0.5–1.5 GB. On a 4 GB machine add a swap file first (`docs/small-servers.md`) and run one browser task at a time.
- `aigentron addon status|logs|disable [--purge] playwright` work as for the browser.

## Layout and contract

```
infra/addons/browser/
  addon.json          name, title, description, requires {ramMb, diskMb}, ports {view, cdp}, backends, docker {volume, shmMb}
  bare.sh             the installer: install | build | uninstall [--purge] | status  (see the header of the file)
  browser-run.sh      the process launcher both the systemd units and the container entrypoint use (one place for the command lines)
  cdp-proxy.py        Docker only: makes CDP reachable by container name (Chromium refuses non-IP Host headers)
  docker/Dockerfile   FROM debian:12; RUN bare.sh build; ENTRYPOINT docker/entrypoint.sh (a tiny shell supervisor)
```

After `enable` the installer writes `<data>/addons/<name>/state.json`, which is all the orchestrator reads (it never installs anything):

```json
{ "name": "browser", "enabled": true, "backend": "bare", "version": "1", "installedAt": "2026-10-19T09:20:42Z",
  "browser": "chromium", "arch": "aarch64",
  "endpoints": { "view": "http://127.0.0.1:6080", "cdp": "http://127.0.0.1:9222" },
  "profiles": ["agent"], "notes": ["display: x11vnc + openbox"] }
```

`browser` is `chrome`, `chromium` or `playwright-chromium`; `endpoints.cdp` is `null` when CDP is off. With the Docker backend the endpoints
name the container (`http://aigentron-browser:6080`, reachable from the orchestrator container over the internal `aigentron` network), or
`127.0.0.1` on a bare-metal server that chose `--backend docker`. `disable` writes `enabled: false` and keeps the file. Under Docker the file is
written into the orchestrator's `/data` volume through `docker exec`.

## What `enable browser` does on a bare-metal server

1. **Preflight** — root, systemd, a supported OS (`/etc/os-release`: Debian 11+, Ubuntu 22.04+ with apt (newer than the tested ones: a warning, then go ahead; a library renamed with the `t64` suffix is found by itself, one that is gone is skipped with a warning); Amazon Linux 2023 and
   Fedora with dnf — anything else is refused with a pointer to the Docker backend), x86_64 or aarch64, ≥ 2 GB free on `/opt` and `/var/lib`,
   a warning below 3 GB RAM.
2. **Display stack** — `Xvfb` + `openbox` + `x11vnc` (apt, Fedora); on Amazon Linux, which packages neither x11vnc nor openbox, TigerVNC's `Xvnc`
   (X server and VNC server in one) and no window manager. The X display is protected by an xauth cookie only the add-on's user holds.
3. **Browser ladder** — `--browser chrome` → Google Chrome stable from Google's signed repository (x86_64 only); otherwise the distro's real
   `chromium` package (Debian, Fedora — Ubuntu's `chromium-browser` is a snap stub and is skipped); otherwise **Playwright's Chromium**
   (pinned `playwright@1.56.1`, `npx playwright install chromium` into `/opt/aigentron/browser/playwright`, plus the system libraries it needs —
   listed in `bare.sh` for apt and dnf; Node 22 from NodeSource when the host has no node ≥ 18). Default order: Chrome (x86_64) → distro
   chromium → Playwright. The Docker image defaults to the distro's chromium (`--build-arg BROWSER=…` to change).
4. **noVNC 1.5.0 + websockify 0.12.0** — downloaded from the pinned GitHub tags and **sha256-verified** (the hashes are in `bare.sh`; a mismatch
   stops the install) into `/opt/aigentron/browser/{novnc,websockify}`; `index.html` = `vnc.html`, `defaults.json` makes it auto-connect and scale.
5. **User and profile** — the system user `aigentron-browser` (home `/var/lib/aigentron-browser`, mode 0700, no shell); the browser profile is
   `/var/lib/aigentron-browser/profiles/agent`. Stage 1 has only this one, empty `agent` profile.
6. **systemd** — `aigentron-browser.target` with `aigentron-browser-{display,wm,vnc,novnc,browser}.service` (only the ones this host needs).
   All run as `aigentron-browser` with `ProtectSystem=strict` (only the home and `/tmp` writable), `ProtectHome`, `NoNewPrivileges` (except the
   browser, whose own sandbox needs user namespaces), restricted address families, `Restart=always`; the browser unit has
   `MemoryMax=<requires.ramMb>M` (2 GB) from `addon.json`. The units are rewritten only when their content changes, so a re-run does not restart
   anything. Chromium starts with `--user-data-dir=<profile> --no-first-run --window-size=1440,900 --remote-debugging-address=127.0.0.1
   --remote-debugging-port=9222`; `--no-cdp` (env `AGENT_CDP=off`, kept in `/opt/aigentron/browser/env.local`) starts it without the debugging port.
7. **Ports** — everything on loopback: noVNC `127.0.0.1:6080` (HTTP + WebSocket, **no authentication of its own** — the orchestrator proxies it behind
   the dashboard's sign-in), VNC `127.0.0.1:5900`, CDP `127.0.0.1:9222`. The installer then waits for both endpoints and writes `state.json`.

`disable` removes the units (profile and `/opt/aigentron/browser` stay); `disable --purge` also removes the profile, the user and the files.
OS packages are never removed (the message tells you the `apt remove` / `dnf remove` line).

## The Docker backend

`aigentron addon enable browser` on a Docker install (or `--backend docker` on a bare-metal one) builds `aigentron-browser:<version>` from
`infra/addons/browser/docker/Dockerfile` — `debian:12` + `bare.sh build` (the same steps as above minus systemd and state.json; the browser is the
distro's chromium, ~1.4 GB image on arm64) — and starts the container `aigentron-browser`:

- `--restart unless-stopped --shm-size 512m --memory 2048m`, the profile in the named volume `aigentron-browser-data` (kept across re-creates and
  image updates; `disable --purge` removes it);
- on a Docker install: the user-defined network `aigentron` (created on demand; the orchestrator container is connected to it), **no published
  ports** — the orchestrator reaches `http://aigentron-browser:6080` / `:9222` by name; on a bare-metal server: `-p 127.0.0.1:6080:6080 -p 127.0.0.1:9222:9222`;
- inside, `docker/entrypoint.sh` starts the same components through `browser-run.sh` as the unprivileged user (`setpriv`), restarts one that dies and
  stops them all on `SIGTERM`. Chromium runs with `--no-sandbox` there (the container is the boundary; Docker's default seccomp profile blocks the
  namespace sandbox). CDP goes through `cdp-proxy.py` (`0.0.0.0:9222` → `127.0.0.1:9223`), which rewrites the `Host` header Chromium would otherwise
  reject and the `webSocketDebuggerUrl` in `/json*` answers back to the name the client used. Idle use: ~250 MB RAM.

The add-on files come from the release checkout next to the install's `.env` (`<install>/releases/<version>/infra/addons`); when that is gone they are
copied out of the running image (`/app/infra/addons`). The dev compose stack has the same container as the `browser` profile
(`docker compose --profile browser up -d browser`, host ports on loopback via `BROWSER_VIEW_HOST_PORT` / `BROWSER_CDP_HOST_PORT`,
`BROWSER_AGENT_CDP=off` to start without CDP); it does not write `state.json` — write one under the dev data dir (`workspace/addons/browser/state.json`,
endpoints `http://aigentron-browser:6080` / `:9222`) if the dashboard page should show it.

## Security model (stage 1)

- **CDP is full control of the browser** — every tab, cookie, password and download of the profile — for anything that can reach the port.
  Agents have a shell on the server and can reach loopback / the internal network, so in stage 1 the browser holds only the empty **`agent`**
  profile: never sign in to anything personal in it. A personal, logged-in profile and a mediating MCP tool (agents get tabs, not the raw
  protocol) come in a later stage. `--no-cdp` gives you a watch-and-operate-only browser agents cannot drive at all.
- **The noVNC endpoint has no login of its own.** It is bound to loopback / the internal Docker network only, and the orchestrator proxies it
  behind the dashboard's sign-in (operator/admin), with viewer and time limits — see below. Never publish 6080 or 9222 (a firewall rule, a tunnel
  hostname, a compose `ports:` change on a public interface).
- Viewing is operating: whoever watches can type, and the agents' sessions live in the same profile.
- The add-on runs as its own OS user; with agent isolation on (`aigentron harden`) the agent user and the browser user cannot read each other's
  files. The X display is cookie-protected (`.Xauthority`, 0600) so another local user cannot watch or inject input through X — only through CDP/VNC on loopback.
- Downloads land in the profile's home (`/var/lib/aigentron-browser`), not in the workspace; the backup (`aigentron backup`) does not include the profile.

## Troubleshooting

- `aigentron addon status browser` shows which component does not answer; `aigentron addon logs browser` follows all units (`journalctl -u
  'aigentron-browser*'`) or the container log.
- A re-run of `enable` is the repair command: it reinstalls only what is missing, rewrites changed units and restarts them.
- "systemd is required" inside a container → use the Docker backend; "this add-on supports …" → unsupported OS, same answer.
- Chromium's `dbus`/`PHONE_REGISTRATION_ERROR` lines in the log are noise (no system bus / no Google services on a server), not failures.
- Verified on this release: Debian 12 (distro chromium 155), Ubuntu 24.04 (Playwright chromium 141), Amazon Linux 2023 (Xvnc + Playwright chromium 141),
  all arm64 with systemd; the Docker image on arm64. Google Chrome (x86_64 only) and Fedora follow the same code paths but were not exercised on this machine.

<!-- The infra side (what add-ons are, the installer, `aigentron addon …`, systemd units, the docker image) is documented above this
     line by the infra stream; the section below is the orchestrator + dashboard side and is kept separate on purpose. -->

## Orchestrator side

What the server app does with an add-on — it only **reads** and **shows**; nothing is installed, enabled or disabled through the API or the
dashboard. Code: `apps/orchestrator/src/addons/`, page: `apps/dashboard/src/pages/AddonsPage.tsx` (tabs Browser — `BrowserPage.tsx`, the live view — and Playwright — `PlaywrightAddonPanel.tsx`; `/browser` redirects to `/addons?tab=browser`).

### Where it looks

- **Descriptors** — `infra/addons/<name>/addon.json`, found next to the app the same way as `infra/hooks` (repo-root-relative, so the
  bare-metal, minimal and compose layouts all work); `ADDONS_DESCRIPTORS_DIR` overrides. A build without that folder still knows the
  `browser` add-on from a built-in descriptor (the file wins when present).
- **State** — `<data dir>/addons/<name>/state.json`, written by the installer. The data dir is the parent of the secrets dir
  (`/data` on bare-metal/minimal, `/workspace` under the dev compose); `ADDONS_DIR` points elsewhere.
- Both files are **validated, never trusted**: names (`[a-z][a-z0-9-]*`), ports 1–65535, known backends, lists trimmed. `endpoints.view`
  / `endpoints.cdp` must be plain `http://` URLs (no credentials, query or fragment) on **loopback, `host.docker.internal`, a single-label
  docker service name, or an RFC 1918 address** — anything else (a public name, `https://`, …) makes the whole state unusable: the add-on
  then counts as *not installed*, the reason is shown on the page and logged once.

### API (read-only, any signed-in role)

- `GET /api/addons`, `GET /api/addons/:name` — descriptor + state + a **live health probe** of the view endpoint (one `GET /`, 1.5 s
  timeout, cached 5 s, shared between concurrent callers) → `status`: `not-installed | enabled-healthy | enabled-unreachable | disabled`,
  the exact commands to show (`sudo aigentron addon enable <name>`, `… --backend docker`, `aigentron addon logs <name>`), and the viewing
  limits (`view.maxSessions`, `view.sessionMinutes`, `view.active`). There are no mutating routes.

### The view proxy — `GET/WS /api/addons/browser/view/*`

The add-on's view endpoint is a noVNC web client (HTTP + WebSocket) **with no sign-in of its own**; it must stay on loopback / the internal
network, and the orchestrator puts it behind the dashboard's sign-in:

- **Who** — the page and the WebSocket handshake pass the same gate, in this order: domain allow-list (Settings → Security → Access) → Cloudflare
  Access token (when on) → the session cookie → the **operator or admin** role (whoever watches can also type into the browser). Otherwise
  401 (no session) / 403. With sign-in off, the acting-user header or the default operator counts, as everywhere in the API.
- **Headers** — allow-lists in both directions. Cookies, `Authorization`, `x-lds-user`, `X-Forwarded-*` / `cf-*` never reach the add-on;
  its `Set-Cookie` / `X-Powered-By` never reach the browser. Every answer carries `X-Frame-Options: SAMEORIGIN`,
  `Content-Security-Policy: frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a `private`
  `Cache-Control`. Only `GET`/`HEAD` are relayed; a path that climbs out (`..`) is refused before anything is forwarded.
- **Limits** — `ADDON_VIEW_MAX_SESSIONS` (default 3) streams at once; the next one gets `503 Too many viewers`.
  `ADDON_VIEW_SESSION_MINUTES` (default 120) per stream; at the end the browser receives a close frame `1000 "Session time is over"` and the
  page offers *Start a new session*. The browser on the server keeps running — only the viewing stops.
- **Audit** — one log line per open and close through the app logger (`[Addons] browser view opened by Olga (operator) from 203.0.113.7
  — 1/3 watching, ends in 2h 00m` / `… closed for Olga after 12m 05s (closed by the viewer) — 0/3 watching`). The address believes
  `cf-connecting-ip` only from a trusted proxy, like the sign-in does. The app has no persistent audit store for this yet, so the log is
  the record.
- **Listeners** — the API port at boot, and the 80/443 listeners as `web/web-server.service.ts` binds them (it attaches the Socket.IO
  server to each; the proxy rides on that call). Behind your **own reverse proxy**, forward WebSocket upgrades for
  `/api/addons/browser/view/` as you do for `/socket.io`. A Cloudflare Tunnel needs nothing extra.
- **Transport** — plain `node:http`: the upstream request is made with the filtered headers; on `101` the two sockets are piped. No proxy
  library is involved (none is a dependency).

### What is *not* protected (stage 1)

- The noVNC endpoint itself has no authentication: the whitelist keeps the proxy on internal hosts, but keeping port `6080`/`9222` off
  the public interface is the installer's job (host firewall / bind address).
- Viewing = operating: anyone who can watch can type, and the agents' sessions live in the same browser profile — the page says so.
- The CDP port is never proxied; agents will reach it through an internal mediating tool in a later stage.
- The proxy does not throttle bandwidth; a VNC stream over a slow link just lags.

### Dashboard

`🌐 Browser` in the header → `/browser`. Not installed → a card with what it is, the requirements from `addon.json`, and the two enable
commands with copy buttons. Running → the noVNC page in an iframe sized to the rest of the screen, a toolbar above it (status chip,
viewers and time left, *Open in a new tab*, *Fullscreen*) and the shared-browser warning. Not answering → a card with the health error and
`aigentron addon logs browser`; the page re-checks every 10 s. Reviewers see the status but not the view. noVNC is opened as
`vnc.html?autoconnect=1&resize=scale&path=api/addons/browser/view/websockify` — `path` makes it open its WebSocket through the same proxy.

### Tests

`apps/orchestrator/src/addons/addons-core.test.ts` (parsing, whitelist, header filters, session limiter) and `view-proxy.test.ts` (the
proxy against a fake noVNC on ephemeral ports: 401/403/200, stripped headers, framing headers, WebSocket echo, the cap, the time limit,
a down add-on). `pnpm test:di` checks the module wiring.
