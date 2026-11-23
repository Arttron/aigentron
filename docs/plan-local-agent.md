# Plan: the Aigentron local agent (a Go daemon on the person's own machine)

Status (2026-11-23): **L0, L1 (read only) and L1.5 (local models through the line) built** — L1.5: `aigentron-local llm …` (backends on localhost + an allow list, set on the machine only), commands `llm.models` / `llm.chat` (streamed as `llm.chunk` events) / `llm.cancel`, the OpenAI-compatible `/api/local-llm/v1` endpoint, provider `local-llm`. **Local mode built (stage A)**: `aigentron-local chat` — an agent loop on the machine with a local model, read tools + edit/write/commit behind terminal approvals. Not built: sync of local sessions to the server, running commands/tests, streaming output, an approvals UI beyond the terminal. **L1** — L1: roots (`add` / `remove` / `roots`), the hard limits (path resolution, never-list, hardened git), the repository watcher (event `repos`), `LocalBinding` with the origin check, the `local-os` MCP server (`local_repos` / `status` / `diff` / `log` / `read`), the repositories panel. Decisions of L1: a binding is the person's consent for READ, so reads need no card (cards come with writes in L2); a root is a repository's top folder; polling `git status` instead of fsnotify for now (events for idle detection come with the rules engine). **L0** (the Go daemon: `login` / `pair` / `run` / `server` / `status`; the server: device flow, devices, WebSocket gateway, `install.sh`, package cache, the **Add-ons → Local agent** tab, the release job; tested end to end with the real binary against the real controller and gateway). L1+ are plans. Language: **Go** (decided). User documentation: `docs/addons.md` → «The local agent».

Decisions taken while building L0: sign-in by a link (device flow) is the main way, a one-use code the fallback · one-command install (`curl … | sh`, SHA-256 checked) rather than a browser download (macOS Gatekeeper quarantines browser downloads) · the server fetches the binaries of its own version from the release and caches them · the server address lives in the daemon's config (`aigentron-local server <url>` changes it, the install script takes `AIGENTRON_SERVER`) · release signing (minisign / cosign) is still to do **before** any self-update (L3).

Agents run on the server today (the checkout or a worktree of the project); they cannot see the code on a person's laptop. The only bridge is a shared
git remote (`docs/work-on-server.md`, "Way 1"). The local agent closes that gap: a small program on the person's machine that **watches a local
repository, keeps it safe and in step with the remote, and lets server-side agents act on it** — all under approvals.

## 0. What already exists and is reused

The browser extension (`docs/plan-browser-extension.md`) is the precedent — same shape, other hands:

| Extension | Local agent |
|---|---|
| one-use 60 s pairing code (`PairingCodes`) | the same code, redeemed by the daemon |
| device credential `ext_<id>_<secret>`, hash in `secrets/` | `lag_<id>_<secret>`, same store pattern |
| route allow-list for the device token | its own, narrower list |
| `BrowserBridgeService`: command out, result back, one task at a time, Stop | `LocalBridgeService`: the same |
| built-in MCP server `browser-ext`, seeded read-only for the approval classifier | built-in MCP server `local-os` |
| cards per site and task, "never" list, submit card that no model can confirm | cards per repo and task, "never" paths, commit / push / run cards |
| presence ("the person is active") | presence from the OS idle time; a person typing pauses the agent |

Approvals, `*_TOOL` constants in `@lds/shared` `classify.ts`, untrusted-data labels and the audit trail are reused as they are.

## 1. Principles

1. **No LLM in the watch loop.** Watching, snapshots, fetch and fast-forward are deterministic rules in the daemon. A model is called only on an event
   (write a commit message, review a diff, decide about a conflict) — by the server, through the normal task flow.
2. **The person's branch and index are not touched without a card.** Automatic safety is done beside the working tree (see 3.1).
3. **Read first, write later, each write behind an approval class.** Every stage below adds one class of power.
4. **Outbound connection only.** The daemon dials the server; nothing listens on the laptop.
5. **The daemon is dumb, the server decides.** Policy, approvals, grants and audit live in the orchestrator; the daemon enforces its own hard limits on top
   (roots, never-paths, git states) so a compromised server or model cannot widen them.

## 2. Why Go

- One static binary per OS / CPU (`darwin/arm64`, `darwin/amd64`, `linux/amd64`, `linux/arm64`, `windows/amd64`): **no Node, no runtime on the laptop**;
  cross-compiled in CI. A small idle footprint (a watcher that sits there all day).
- Good fit for the work: `os/exec` with process groups and timeouts, `fsnotify`, a plain WebSocket client, goroutines per watched repo.
- macOS arm64: the Go linker ad-hoc signs the binary; a file fetched with `curl` carries no quarantine flag, so Gatekeeper does not block it. Notarization is
  a later, optional step (needed only for a `.pkg` / a download through a browser).

What Go changes in this repository:

- **A separate toolchain.** `apps/local-agent/` is a Go module (`go.mod`), outside the pnpm / turbo graph; `@lds/shared` cannot be imported.
  Go is not installed on the dev machine yet — a prerequisite for L0.
- **The protocol is a contract, not shared code.** It is described once as JSON schemas + example frames in `packages/shared/protocol/local-agent/`
  (fixtures). A TypeScript test (orchestrator) and a Go test (daemon) both load the same fixtures — a drift breaks CI on one side or the other.
  A protocol version is sent in the handshake (min / max); an old daemon against a new server degrades to "update me", never to undefined behaviour.
- **Plain WebSocket, not Socket.IO.** The extension needed a hand-written Socket.IO client; Go's Socket.IO clients are weak. The orchestrator gets a native
  WebSocket endpoint (`/api/local-agent/ws`, JSON frames `{id, type, …}`, request / response with ids, server pings) next to the existing Socket.IO
  gateway. *To check in L0:* the cleanest way to add it beside `@nestjs/platform-socket.io` (a `ws` upgrade handler on the HTTP server for that path).
- **Git by the system `git`, not `go-git`.** `stash create`, worktrees, hooks, credential helpers and the person's own config must behave exactly as in their
  terminal. The daemon requires `git` ≥ 2.30 and says so when it is missing.
- **Release pipeline.** `release.yml` gets a job that cross-builds the binaries (`-ldflags "-X main.version=$(cat VERSION)"`, `CGO_ENABLED=0`), adds them to the
  GitHub Release and the S3 directory, and to `SHA256SUMS`. `publish/allowlist.txt` gets `apps/local-agent/`. The server **never builds** (as with the
  extension): `GET /api/local-agent/package?os=&arch=` serves the file for the server's own version, with its SHA-256; `install` and `update` verify it.
  The daemon version equals `VERSION`.
- **CI.** `go vet`, `go test ./...` (with `-race`), `staticcheck` on the module; Make targets `local-agent-build`, `local-agent-test`.

## 3. Design

### 3.1 Watching and the safety net (no approvals needed — nothing the person can lose)

- Per bound repository: `fsnotify` on the working tree (ignoring `.git`, `node_modules`, and everything `git check-ignore` says), debounced; a slow
  `git status --porcelain=v2 -b` poll as the backstop (fsnotify loses events on big trees).
- **WIP snapshots** without touching the branch, the index or the working tree: `git stash create` (plus untracked files via a temporary index with
  `git add -A` on `GIT_INDEX_FILE`) → a commit object stored under `refs/aigentron/wip/<branch>/<n>` (the last N kept). Restorable by `git stash apply <sha>`
  or `aigentron-local restore`. This is the "keep an eye on my code" part, and it is safe by construction.
- `git fetch` on a timer (`--prune`, never `pull`), ahead / behind computed locally.
- **Quiet rules** (the daemon does nothing, or waits, when): `index.lock` exists; a merge / rebase / cherry-pick / bisect is in progress
  (`.git/MERGE_HEAD`, `rebase-merge/`, …); the person edited a file or typed in the last N seconds (idle time from the OS); the repository is on a detached HEAD
  (only snapshots, nothing else).

### 3.2 Rules (the policy, configured on the server, enforced in the daemon) — **config layer built (2026-11-23)**: global (server, synced) + `.aigentron/local.yaml` per project; a project file can only switch off / tune / lengthen the quiet time, never switch on unless `projectCanEnable` allows (docs/addons.md). The engine that acts on the rules is L2.

Per repository, in the dashboard (Local agent page) — a short list, no scripting language:

| Rule | Default |
|---|---|
| snapshot while the person is idle ≥ 2 min | on |
| fetch every 5 min | on |
| fast-forward the current branch (`pull --ff-only`) when the tree is clean | off |
| notify when ahead / behind / dirty longer than N | on |
| propose a commit when the tree has been dirty and idle for N min | off (it opens a task, never commits by itself) |

### 3.3 Tools given to server-side agents (`local-os`, an MCP server)

Read (no card): `local_status`, `local_diff`, `local_log`, `local_read` (inside the repository only), `local_snapshots`.
Write, each with its own approval class: `local_commit` (stages the listed paths, the card shows files + message), `local_branch`, `local_pull` (ff-only; anything
else is refused with the reason), `local_push`, `local_run` (a command line, a card each; timeout, output cap, process-group kill), `local_restore`.
Never offered: reset --hard, clean, force push, checkout over a dirty tree, anything outside a granted root.

- Grants: **per repository and task**, two levels like the browser (`read`, `write`); "don't ask again" is a standing exception through the existing
  approvals mechanism — **never** for the default branch, force operations and `local_run`.
- A command's `confirmed` flag is set by the server alone (as `BROWSER_SUBMIT_TOOL`); a model's argument cannot carry it.
- Everything read from the machine (file text, commit messages, command output) is labelled **untrusted data**.
- One task at a time uses a repository (a lock, freed after idle); **Stop** in the dashboard cuts a task off.

### 3.4 Hard limits inside the daemon (not the server's to widen)

- Only **roots** the person added with `aigentron-local add <path>`; every path is resolved (`EvalSymlinks`) and must stay under a root.
- A fixed **never** list: `~/.ssh`, `~/.gnupg`, `~/.aws`, keychains, browser profiles, `.env*` and key files (read refused, even inside a root); the list is
  mirrored in a server-side test like the browser's.
- Writes only in the states of 3.1 that allow them; one writer per repository at a time.
- Child processes: no inherited secrets (a clean environment + an allow-list of variables), a working directory inside the root, a process-group kill on timeout / Stop.

### 3.5 Binding to a project and handing work over

- `LocalBinding { projectId, deviceId, localPath }`; accepted only if the local `origin` matches the project's `repoUrl` (normalised) — an agent of project A
  cannot act on the repository of project B.
- **Hand-off to a server agent:** push the WIP ref (or a chosen branch) to origin → a task in worktree mode starts from it → the result comes back as a branch /
  PR the person fetches. This is the clean answer to "a person and an agent in the same code": they never share a working tree.
- "Review my diff": one button — the diff goes into a chat task as a labelled data block (like the browser extension's bug report).

### 3.6 The daemon

```
apps/local-agent/
  cmd/aigentron-local/main.go      subcommands: pair, run, install, uninstall, add, remove, status, restore, update, version
  internal/proto/                  frame types + the fixture-driven contract test
  internal/link/                   the WebSocket client: pairing, reconnect with backoff, ping, replay of queued events
  internal/repo/                   watcher, git runner, snapshots, quiet rules
  internal/policy/                 roots, never-paths, rules from the server, grants received with each command
  internal/exec/                   process runner (groups, timeouts, caps, clean env; Windows variant)
  internal/svc/                    launchd / systemd --user / Windows Task Scheduler install
  internal/update/                 download + SHA-256 + atomic replace + restart
```

- Credentials: the device token in a `0600` file under the user's config dir at first; the OS keychain (`go-keyring`) later.
- Logs to the user's log dir with rotation; `status` shows the link, the roots, the last snapshot, the last error — and never prints the token.
- Offline: snapshots and fetches continue; events are queued (bounded) and sent after reconnect.

### 3.7 Server side (orchestrator)

`apps/orchestrator/src/local-agent/`: `local-agent.module`, `local-agent.controller` (pair / me / revoke / package / devices), `local-bridge.service`
(WebSocket gateway, command / result, locks, grants, Stop), `local-mcp.service` (the `local-os` MCP server, a loopback machine route with a per-run bearer
token, as `browser-mcp`), `local-policy.ts` (the never list, the classes), the allow-list for the device token. Prisma: `LocalDevice`, `LocalBinding`,
`LocalRule`. Constants in `classify.ts` for each write tool (the existing test enforces them). Dashboard: **Settings → Local agent** (install command, pairing
code, devices, repositories, rules, recent local actions) and a repository card on the project page.

## 4. Stages

**L0 — skeleton.** Go toolchain and CI jobs; module, `version`, `pair`, `run` (connect, ping, reconnect), `install` / `uninstall` for launchd first; protocol
fixtures + contract tests on both sides; server: WebSocket endpoint, pairing, device store, allow-list, `package` download; dashboard page with the device
list and the install one-liner. *Done when:* a laptop pairs, shows "online", survives a server restart, can be revoked.

**L1 — read-only.** `add` roots, watcher, `git status` events into the dashboard, `local-os` read tools, `LocalBinding`, the origin check, the never list with its
mirrored test. *Done when:* an agent asked "what did I change today" answers from the real working tree, and cannot read `~/.ssh`.

**L2 — safe writes.** WIP snapshots + `restore`, fetch timer, quiet rules, the rules page, `local_pull` (ff-only), `local_commit` and `local_branch` with cards,
presence pause. *Done when:* a kill -9 of the editor loses nothing, and no card-less action ever changes the person's branch.

**L3 — push and the server loop.** `local_push`, hand-off to a server worktree and back, "review my diff", `local_run` with cards, the audit page, systemd and
Windows service install, self-update. *Done when:* a change made locally can be handed to an agent, comes back as a PR, and the laptop updates itself.

**L4 — optional.** Native notifications, extra roots outside git, a local small model (Ollama) for commit messages, a tray app, notarized `.pkg`, keychain storage.

## 5. Risks

- **A shell on a personal machine.** Hence read-only first, a card for every write, hard limits that live in the daemon, and no standing exception for
  `local_run`, force operations or the default branch.
- **Prompt injection** through files, commit messages and command output: labelled data; dangerous actions confirmed by a person, the flag set by the server.
- **Races with the editor / IDE:** snapshots beside the tree, quiet rules, ff-only, one writer per repository.
- **Contract drift between Go and TypeScript:** shared fixtures tested on both sides, a protocol version in the handshake.
- **Platform differences** (Windows paths and process groups, macOS Gatekeeper, Linux without systemd): macOS and Linux first; Windows from L3.
- **Server unreachable:** the daemon keeps protecting the code locally and catches up after reconnect.

## 6. Decided / open

Decided: Go · headless daemon with a dashboard page (no tray in the first stages) · plain WebSocket · system `git` · macOS first, then Linux, Windows from L3 · LLM
only on events, run by the server.

Open: (1) whether the first release ships snapshots-only (L0–L2) before any command execution — **recommended**; (2) the default of the fast-forward rule (off);
(3) the keychain vs a `0600` file for the token in L0 (file); (4) whether `local_run` is ever allowed without a card for a person-curated list (e.g. `go test`) — **no** until L3 has run in practice.
