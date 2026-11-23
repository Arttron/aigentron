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

**Stop / start / restart from the dashboard.** On a bare-metal server an operator can stop, start or restart the **Playwright** and **voice** add-ons with the buttons on their Add-ons tab (`POST /api/addons/<name>/control/<start|stop|restart>`): the orchestrator runs `systemctl <action> aigentron-<name>.service` — the unit is looked up from a fixed list, nothing from the request reaches the command line — and then waits up to ~10 s for the service to answer. It needs systemd and root rights (a bare-metal install has them; otherwise the tab says why and shows nothing to click). Installing and removing stay on the command line. The **browser** add-on (several services that depend on each other) and Docker-run add-ons are not controlled from here (`docker compose restart …`).

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
- **Screenshots for the person**: the unit saves what the browser writes (a screenshot taken with a `filename`) in `/var/lib/aigentron-playwright/output` (`--output-dir`); the orchestrator reads that folder, so an agent can put the picture in the chat with `show_images` (name as the tool reported it). `PLAYWRIGHT_OUTPUT_DIR` overrides the folder. The files belong to the add-on's user (mode 0600): the orchestrator must run as root, as on a bare-metal install. A Docker `playwright-mcp` container keeps its output inside itself — there the agent can only look at the picture, not show it. Re-run `sudo aigentron addon enable playwright` after updating to get the folder.
- **Memory**: a page open in Chromium takes 0.5–1.5 GB. On a 4 GB machine add a swap file first (`docs/small-servers.md`) and run one browser task at a time.
- `aigentron addon status|logs|disable [--purge] playwright` work as for the browser.

**Updating.** `aigentron update` makes the program the version of the server it is paired with: it downloads this platform's archive from that server, checks the SHA-256 (also from that server), unpacks only the program, runs it once to see that it reports the offered version, then swaps it in; the old one stays as `<program>.prev`. A background service of `aigentron service` is restarted by it (only when that service runs this very program). `--check` only says whether there is a new version; `--force` installs the server's version even if it is the same or older. A development build (`aigentron-dev`) is never updated this way. Nothing updates by itself in the background.

**Where the agent works.** Two ways, both explicit on the computer: (1) start `aigentron chat` (or `run`) inside a project's folder — if it is a git repository that is not allowed yet, the program asks once whether to allow it; (2) from any folder run `aigentron open <project>` — it asks the server which projects have a repository (own token; credentials in the address are dropped, a local path / `file:` / `ext::` address is never offered), reuses a copy that is already there (its `origin` must be the project's repository) or clones it after you confirm the address and the folder, with the person's own git login and with hooks / `ext` / `file` transports switched off, then allows the folder. `aigentron open` without a name lists the projects. The server can name a project but cannot make the computer run anything or open a folder by itself.


## The voice add-on (speech on this server)

`sudo aigentron addon enable voice [--no-stt] [--stt-model tiny|base|small|medium]` installs a small **OpenAI-compatible speech server** on loopback
(`http://127.0.0.1:8880/v1`) so voice (docs/voice.md) costs nothing and nothing leaves the machine:

- **Speech synthesis — Piper** (the pinned release binary with its own espeak-ng, no Python needed): the voices `ru_RU-irina-medium` and `en_US-amy-medium`.
  The voice name `auto` (or any name that is not an installed voice, e.g. the OpenAI `alloy`) picks the Russian or the English voice by the **script of the text**, so one
  setting reads both languages. Output mp3 / opus / flac through ffmpeg (WAV without it). Kokoro was not used: it has no Russian.
- **Speech recognition — faster-whisper** (CPU, int8) in a venv; model `small` by default (~460 MB download, ~1 GB RAM while it works; `--stt-model base|tiny` are lighter,
  `--no-stt` installs synthesis only). Returns `json` or `verbose_json` (segment and word times, so "look here" in a video still works).
- **Install**: Debian 11+ / Ubuntu 22.04+ (apt), Amazon Linux 2023 / Fedora (dnf; without ffmpeg the audio stays WAV), x86_64 or aarch64, ~3 GB free disk. Downloads are
  **sha256-pinned** (Piper tarballs, voices); a mismatch stops the install. The unit `aigentron-voice.service` runs as its own user, `ProtectSystem=strict`, loopback only,
  `MemoryMax` from `addon.json`, `HF_HUB_OFFLINE=1` (the model is fetched at install, never at run time). The installer finishes with a real speech test.
- **Use it**: Settings → Voice shows **Use it for recognition and speech** once the add-on is running (it creates the provider `local-voice` — kind OpenAI, Base URL
  `http://127.0.0.1:8880/v1`, no key — and selects it for both halves), or add that provider by hand.
- Code: `infra/addons/voice/` (`server.py` — Python standard library + faster-whisper; tests `python3 -m unittest infra/addons/voice/test_server.py`).
- Bare-metal only (like Playwright). On a Docker install point a provider at any OpenAI-compatible speech container instead (docs/voice.md).

## The extension (built with the project, configured per server)

The **browser extension** (Chrome / Edge / Brave) is listed under **Add-ons → Extension** in the dashboard, but unlike the others nothing is installed on the server: the extension is **built with
the project** (`pnpm --filter @lds/extension build` → `apps/extension/dist`, part of `install.sh`, `minimal.Dockerfile` and the dev entrypoint) and the server only writes its **configuration** — this
server's addresses, name and key — into a copy of it when you press *Download* (`GET /api/extension/download`). You unzip it, *Load unpacked* in `chrome://extensions`, and press **Connect** in the
dashboard (a handshake with the signed-in page; needs a sign-in password). Plan and details: `docs/plan-browser-extension.md`. The tabs of the page: Browser, Playwright, Voice, Extension, Local agent.

## The local agent (a program on your own computer)

**Add-ons → Local agent** is for a small Go program, `aigentron`, that runs on **your** computer (macOS / Linux; Windows archive is built) and keeps one outbound WebSocket to this server, so that server-side agents can — in later stages, under approvals — work with the code on your machine. Nothing is installed on the server and nothing listens on your computer. Plan, safety model and stages: `docs/plan-local-agent.md`. **Stages built: L0** (connect, show the computer, disconnect) **and L1 — read only** (below). Writing (snapshots, fetch, commit) is L2.

- **Install**: the tab shows `curl -fsSL <this server>/api/local-agent/install.sh | sh`. The script finds the platform, downloads the archive **from this server**, checks its SHA-256, puts `aigentron` into `~/.local/bin` (`AIGENTRON_LOCAL_BIN` changes the folder; the older name `aigentron-local` stays as a link to it) and runs `aigentron login`. The server's own command-line tool (bare-metal installs) is also called `aigentron`: if another one comes first in your PATH the installer says so — call `~/.local/bin/aigentron` (or `aigentron-local`) then. The settings folder keeps its old name (`aigentron-local`), so an existing pairing survives the rename. The server never builds anything: it fetches the release asset of **its own version** (`aigentron-local_<version>_<os>_<arch>.tar.gz`, `.zip` on Windows) from the public release (`UPDATE_REPO`, default `Arttron/aigentron`), verifies it against the release's `SHA256SUMS` and caches it in `<agent dir>/cache/local-agent/<version>/`. A development build (`APP_VERSION` not `X.Y.Z`) has nothing to hand out. A server installed from S3 (`S3_PREFIX`) does not fetch from S3 yet.
- **Sign in by a link** (device flow, like `gh auth login`): `aigentron login --server <url>` prints a link and a short code (`ABCD-2345`) and opens the browser; on the dashboard you see which computer is asking and press **Approve**; the program then receives its own credential `lag_<id>_<secret>` (only a hash is kept in `secrets/local-agent-devices.json`). The code is valid 10 minutes. For a machine without a browser: **Create a one-use code** on the tab → `aigentron pair --server <url> --code <code>`.
- **Another address (domain)**: the address is not baked into the program. `install.sh` uses the address it was **downloaded from** as the default (`AIGENTRON_SERVER=https://other.example sh install.sh` overrides it); the address is saved in the program's config (`~/Library/Application Support/aigentron-local/config.json` on macOS, `~/.config/aigentron-local/` on Linux). If the server moves to a new domain, run `aigentron server https://new.example` — the pairing (the credential belongs to the server, not to the domain) is kept; or `aigentron login --server …` to sign in again.
- **Connection**: `GET /api/local-agent/ws` (WebSocket, `Authorization: Bearer lag_…`; the domain allow-list applies, a revoked token gets 401). Frames and the protocol version are fixed by the fixtures in `packages/shared/protocol/local-agent/`, which the Go program and the orchestrator both test against. Disconnecting a computer on the tab closes its line at once and the program stops retrying.
- **Repositories (L1, read only)**. On a computer, `aigentron add <path>` allows a git repository (its **top folder**; your home folder, a folder above it, or a secret folder is refused), `aigentron roots` lists them, `aigentron remove <id|path>` takes one back. The running program polls each allowed repository (`git status`, without taking locks) and reports branch, ahead / behind, staged / unstaged / untracked counts, a merge / rebase in progress and the changed files; the tab shows them per computer (a changed repository is re-sent at once; `AIGENTRON_LOCAL_POLL_SECONDS` changes the 5 s interval). A token written into the `origin` URL is stripped on the computer before anything is sent.
- **Sharing with a project**: on the tab, **Share (read only)** binds a repository to a project (operator / admin, or the computer's owner). **The binding is the consent**: from then on every agent of that project gets the MCP server `local-os` automatically (not the admin, not discussion turns) with five read-only tools — `local_repos`, `local_status`, `local_diff`, `local_log`, `local_read` — and no approval card is asked for reading. A binding is usable only while the computer is online, still allows the repository, **and the repository's `origin` is the project's `repoUrl`** (so an agent of project A cannot reach project B's code, whatever it is told); otherwise the tab says why. Removing the computer drops its bindings. Everything the tools return is labelled untrusted data.
- **What is never readable** (hard limits in the program, not settings): anything outside an allowed repository (paths are resolved with symlinks, a link that points out is refused); `.git`, `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`; `.env` and `.env.*` (but not `.env.example` / `.sample` / `.template`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*` / `id_ed25519*` …, `.netrc`, `.npmrc`, `.git-credentials`; binary files; files over 8 MB (64 KB per read). These files are also left out of every diff. Git is run with a hardened configuration (no fsmonitor, no external diff / pager, no hooks, no credential helper, no optional locks), so a hostile repository's own `.git/config` cannot run a program.
- **Models on your computer (L1.5)**. A model that runs on a connected computer — Ollama, LM Studio, llama.cpp's `llama-server`, anything with the OpenAI-style `/v1` API — can serve this server's agents. The server sends the chat request over the line the program already holds open; the program forwards it to the model on `localhost` and streams the answer back (no port is opened, nothing to tunnel). **The setup is made on that computer and never pushed from the server**, so the server cannot make the machine call an arbitrary address or widen what is shared: `aigentron llm add ollama http://localhost:11434` (LM Studio `http://localhost:1234`; a non-loopback address needs `--allow-remote`), `aigentron llm allow 'qwen3-coder*'` (names, patterns, or `*`; nothing is shared by default), `llm deny`, `llm remove`, `llm parallel <1-8>` (requests served at once, default 1), `llm` alone shows the setup and what the server can see. The tab lists the shared models and **Use as provider** creates the provider `local-llm` (kind openai) pointing at `/api/local-llm/v1` of this server, with a key of its own; choose it for an agent like any provider. If LiteLLM cannot reach the default address (Docker), edit it in the field next to the button. `model@computer` pins a computer when several share a model. Limits: a request up to 4 MB, an answer up to 16 MB, one request 15 minutes, the stream ends if the model is silent for 2 minutes; when the browser/agent stops, the model is told to stop. **Failover works both ways with the usual agent settings** (`provider`, `fallbackProviders`, `escalation`): when the computer is offline, does not share the model, or the model stops answering, the endpoint answers *503 / 504 Service unavailable …* — which the platform's failover recognises — and the run moves to the agent's next provider; an unreachable local provider is skipped for the next minute and tried again after it (so a laptop that comes back is used again). To work offline-first, put `local-llm` first and a cloud provider in `fallbackProviders`; for cloud-first, the other way round. The endpoint is a machine route (loopback only) and needs the key.
- **Local mode (`aigentron chat`) — no server, no internet.** An agent loop that runs on the computer with a model that runs there too (needs `llm add` for Ollama / LM Studio / llama-server; the models you can use here are all of the backend's, whatever is shared with the server). It works in ONE allowed repository (`--repo <id|path>`, default the one you are in, or the only one): tools `list_files`, `search`, `read_file`, `git_status`, `git_diff`, `git_log`, and — each shown to you with `apply [y/N]` first — `edit_file` (an exact text that occurs once), `write_file` (new files only) and `git_commit` (only the listed files, never a folder, hooks do not run). The same hard limits as the server's read tools apply: secret files are not available to the model (and it is told they exist), paths are resolved inside the repository, `.git` is never written. Without a terminal (`chat -p "<request>"` in a script) every change is declined, so a run there only reads. Text in files, diffs and commit messages is marked as data, not instructions. 30 model calls per message, then it stops and asks you to say "continue". Models that write their tool calls as text (Qwen3-Coder does that through some servers) are understood too. Not built yet: syncing a local session to the server when the line is back, running tests/commands, streaming the answer as it is written.
- **Developing the program itself**: `make local-agent-dev` builds `~/.local/bin/aigentron-dev` (version `dev-<commit>`, never shown as outdated). It keeps its own folder (a folder `aigentron-dev` next to the installed program's `aigentron-local` one in the config directory), pairs as `<host> [dev]` and can be run beside the installed program: `aigentron-dev login --server <url>`, `aigentron-dev run`. Rebuild after each change; the installed `aigentron` is not touched.
- **Rules — two layers**. What an agent may do on its own in a repository (snapshots, fetch, fast-forward, notifications, proposing a commit, how long to stay quiet after you type, extra ignore patterns) is a short document with the same keys in two places:
  1. **Global** — edited on this tab (**Rules → Save and sync**), stored on the server with a revision (`secrets/local-agent-rules.json`) and pushed to every computer: at once to those online, and when a computer connects with an older revision. Each computer keeps the synced copy in `rules.global.yaml` next to its config (overwritten at every sync; it works offline). The tab shows how many online computers have the latest revision.
  2. **Per project** — `.aigentron/local.yaml` in the repository (commit it to share it). Every key is optional; a typo or an out-of-range value is an error, not ignored. `aigentron rules --repo .` prints the rules that apply and why anything was ignored.
  Order: built-in defaults < global < project. **A project file comes from a repository, so it is not trusted to grant power**: it can switch a rule **off**, tune numbers, add ignore patterns and make the quiet time **longer**; it can switch a rule **on** only if the global config lists that rule in "A repository may switch on" (`projectCanEnable`, which a project file cannot contain). The **hard limits are not settings** and are in neither file: which folders the program may touch, the never-list, and which actions need a card. Defaults: snapshots (2 min idle, 20 kept), fetch (5 min), notify on; fast-forward and propose-a-commit off. The two sides (this server and the Go program) are tied by the fixtures in `packages/shared/protocol/local-agent/rules/`. Only managers (operator / admin) can change the global rules.
- **Commands**: `aigentron login | pair | run | add | remove | roots | llm | chat | rules | server | status | unpair | version`. Code: `apps/local-agent/` (Go; `make local-agent-test`, `make local-agent-build`), server side `apps/orchestrator/src/local-agent/`. The release job builds the five archives (`apps/local-agent/build.sh`).

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
