# Plan: the Aigentron browser extension (Chromium)

Status: **E0–E3, in-place updates, E4a and E4b (agent browser control: read, act, forms) built — the plan is complete** (2026-11-02: the template in `apps/extension/` (built with the project into `dist/`), the zip generator, the Connect handshake, tokens, Settings → Extension); E1 (2026-11-02: send a page / selection / link / screenshot with marks as a task or a knowledge-base note, project + agent pickers, per-site project memory, context menu, Alt+Shift+A, `POST /api/extension/clip`); E2 (2026-11-02: approvals and questions on the page the person is on, badge, notification fallback, sound, presence); E3 (2026-11-02: side panel, bug report, dictation) and the in-place update (see below); E4a (2026-11-02: agents read, navigate and search in the person's browser — see below); E4b (2026-11-02: click, type, select, press, scroll, forms with a card for every submit — see below). Decisions of 2026-11-02. A Chromium (Chrome / Edge / Brave) Manifest V3 extension that makes Aigentron available from any tab:
send what you are looking at to an agent, answer approvals where you are, chat in a side panel — and, later, let an agent work in your real browser.

Decided: Chromium only · installed in developer mode (a zip served by the server) · approvals appear on the page the person is on · all five areas
below, with a **project picker** · agent control of the browser (navigate, search, fill forms) included, as the last stage.

## 0. What exists (E0)

- `apps/extension/` — a workspace package `@lds/extension`: `src/` (MV3, plain ES modules: service worker, page bridge, popup, icons via `make-icons.mjs`) and `build.mjs`, which validates the sources and writes the **template** to `dist/`. It runs in the project build (`install.sh`, `minimal.Dockerfile`, the dev entrypoint); **the server never builds the extension — it only writes its configuration into a copy of `dist/`**.
- Server (`apps/orchestrator/src/extension/`): `GET /api/extension/{info,download,me}`, `POST /api/extension/{pair,token,revoke}`; the zip is built by hand (`zip.ts`), the manifest / config rewritten per server
  (`extension-package.ts`), one RSA key per server in `secrets/extension-key.json` (the extension ID), one-use 60 s pairing codes, a **device credential** per paired browser (`ext_<id>_<secret>`, hash only in `secrets/extension-devices.json`, independent of sign-in sessions), and the guard lets it reach **only** `me`, `revoke`, `clip`, `health`, `auth/status`, `GET projects / agents / knowledge` (the list grows with the stages).
- Dashboard: Settings → General → **Browser extension** (download, install steps, Connect / Disconnect, ID, version) and the **Connect banner** when the extension is on the page but not connected.
- Tests: the zip, id, manifest, pairing, route allow-list, the guard, the service on the real template, the page-side reducer — and an **end-to-end test in a real Chromium** (`extension-e2e.test.ts`, set `CHROMIUM_BIN` to a Chromium /
  Chrome for Testing — branded Chrome ≥ 137 ignores `--load-extension`): the real generated package loads, announces itself, takes the code from the page, exchanges it, and the popup lists projects with the stored token.
- Works **with or without a sign-in password**: the extension has its own device credential (see §3); on a server with a password only a signed-in person can press Connect.

### E2 as built

- **Realtime**: a hand-written Socket.IO v4 client over a WebSocket (`lib/sio.js`; the device token goes in the connect packet — `handshake.auth.token` — which the gateway checks), reconnecting with backoff, plus a one-minute alarm. The inbox (`lib/inbox.js`) keeps the pending approvals / questions in `storage.session`, refetches on every (re)connect.
- **The card**: `overlay.js` is injected into the **active tab of the focused window** only after the person grants the **optional** host permission «Show cards on any page» (a button in the popup; the card is only drawn, pages are not read) — a closed shadow root in the top layer; buttons react to **trusted** clicks only and ~0.4 s after the card appears; the card follows the person to the next tab; not drawn on the dashboard itself (it has its own cards), browser pages or the Web Store. Without the permission, or where a card cannot be drawn: a **notification** (Approve / Deny buttons for ordinary approvals) and the badge count.
- **Dashboard-only requests** (`approvalNeedsDashboard` in `@lds/shared`: merge, main / master, outside the folder, credentials, `propose_*`, secret requests): the card shows them with «Open in the dashboard» only, and the server refuses a decision from an extension token (403).
- **Sound**: an offscreen document synthesises it; **not played while a dashboard tab of this server is open** (the dashboard has its own sound).
- **Presence**: the extension tells the server when a browser window is focused and the person is not idle, so the 10 s «dashboard first» rule works with only the extension open.
- Verified in a real Chromium against a fake Socket.IO server (`extension-e2e.test.ts`): connect with the token, presence, the card on an ordinary page, unreachable from the page's scripts, an untrusted click ignored, a real click approves with the token, resolved → the card goes, a dashboard-only card has no Approve, a question answered with a button.

### E3 as built

- **Side panel** (`panel.html`; popup → *Side panel*, the right-click menu, Alt+Shift+P): tasks (*Needs me / Running / All*, per project, live through its own socket), a conversation with an agent (transcript as safe Markdown built from text nodes, follow-ups, live `agent:log` messages), a *New chat* (project, agent, optionally the text of the page you are on) — a plain message is a task through `POST /api/extension/clip` without a page.
- **Report a bug** (panel tab): *Start recording* injects a recorder into that tab only (console errors / warnings, uncaught errors, unhandled rejections, failed `fetch` / XHR / resources; query strings dropped, tokens redacted), *Pick the element* (a click picker: selector, text, outer HTML, box, a few computed styles; form values are never read), *Finish* → a screenshot + environment → the compose tab (tick what to send) → the task carries it as a labelled **data** block (`bugSection` in `clip-core.ts`, redacted a second time on the server).
- **Dictation**: a 🎤 button in the send form and the panel records with `MediaRecorder` and sends the audio to `POST /api/voice/transcribe` (whatever Settings → Voice uses); `mic.html` asks for the microphone once in a normal tab (the side panel cannot show the browser's question).
- Allow-list additions: `GET /api/tasks`, `GET /api/tasks/:id/transcript`, `POST /api/tasks/:id/follow-up`, `GET /api/voice`, `POST /api/voice/transcribe`.

### E4a as built — agents in the person's browser (read, navigate, search)

- **Tools**: the built-in MCP server `browser-ext` (`/api/browser-mcp`, a loopback machine route, a bearer token per run that names the task; seeded read-only for the approval classifier): `browser_tabs`, `browser_open`, `browser_navigate`, `browser_search`, `browser_snapshot`, `browser_read`, `browser_screenshot`, `browser_close`. Every agent gets `browser-ext` **automatically** while at least one extension is paired (not the admin, not discussion turns; `mcpWithBrowser`), unless the person switches it off with the checkbox on the Extension tab (`secrets/browser-control.json`); the core skill `browser-control` teaches the use.
- **Line to the browser**: commands go out over the extension's Socket.IO connection (`ext:command`) and come back as `ext:result` (`BrowserBridgeService`): the browser the person is in front of, one task at a time (a lock, freed after three idle minutes), a **Stop** (`ext:stop`) cuts a task off for ten minutes (*Allow agents again* clears it).
- **Where**: a **separate window**, its tabs grouped «Aigentron» (`chrome.windows`, `tabGroups`); the person's own tabs are untouchable unless one is shared (popup → *Let agents use this tab*). A **frame and banner with Stop** (a trusted click only) show in every tab an agent works in.
- **Which sites**: a **card per site and task** (`BROWSER_GRANT_TOOL`, asked even in the No-approvals mode, decidable from the extension card; «don't ask again … anywhere» is a standing exception through the existing approvals mechanism). **Never** (server and extension both check; the lists are kept identical by a test): banks and payments, password managers, mail / identity providers, cloud consoles, anything with `bank` / `paypal` in the host, cloud metadata addresses, and **the Aigentron server's own addresses** (an agent cannot drive its own dashboard). Local-network addresses are allowed only through a card that says «local network». A tab that ends up on another site (a redirect) asks again; a never-allowed one is refused.
- **What it reads**: a text outline (headings, links with addresses, buttons, fields **without their values**, passwords never), the readable text (paged), a JPEG screenshot. Everything a page returns is labelled **untrusted data** for the model.
- Verified in a real Chromium (commands pushed from a fake server): open / tabs / read / screenshot / close, grants and never-allowed sites enforced in the browser, the frame, a real click on Stop stops the agent, Allow again; and by unit tests (policy parity, the bridge, the grant flow).

### E4b as built — acting on a page, forms

- **Tools** added to `browser-ext`: `browser_click`, `browser_type`, `browser_select`, `browser_press`, `browser_scroll` (+ `interact: true` on `browser_open` / `browser_navigate`). They act on the `[eN]` references of the latest snapshot and return the page afterwards.
- **Grants have two levels**: `read` and `interact` (includes read) — one card per site and task; `interact` is asked for when the agent opens the site for interaction or when a click needs it (the refused action is not lost: it is repeated after the yes; an action that was carried out and landed on another site is not repeated — the new page is read).
- **Never filled**: password, card, one-time-code fields (type, `autocomplete`, name / label words) — the browser refuses and tells the agent to ask the person.
- **Submitting is the person's**: a click on a submit control or a commit-worded button (pay, order, delete, send, sign in …), or Enter in a form, is **not done**; the browser answers `needsSubmit` with the button, the site, the form action and the form's values (sensitive ones masked `••••`); the server raises `BROWSER_SUBMIT_TOOL` — a card with those, decidable from the extension card, asked even in No-approvals mode, **never a standing exception** — and only after a yes re-sends the command with `confirmed` (set by the server alone; a model's argument cannot carry it).
- The fields the agent touched are **outlined**; a real click / key / wheel by the person in the tab **pauses the agent** for three seconds; everything is done through DOM events (not trusted input), so a few sites that insist on trusted events will not react — the planned fallback (`chrome.debugger`, per tab, off by default) is not built.
- Verified in a real Chromium on a test form (type / select / click, password refused, submit gated with the masked values, confirmed submit sends exactly the typed data, the person's click pauses the agent) and by unit tests (levels, retries, the submit card, `confirmed` never taken from a caller).

### Updating the extension

A developer-mode extension is never updated by the browser. What exists: the extension learns the version the server ships (`extensionVersion` in `GET /api/extension/me`, checked at connect and every 30 minutes) and says so — a notice in the popup, a button in the panel, a banner and a line in Add-ons → Extension of the dashboard. **Update the extension** (popup) opens `update.html`: the person points at the extension's folder **once** (File System Access API; the handle is kept in IndexedDB; the browser may ask to allow writing again), the extension downloads `GET /api/extension/package` (the same zip, with the addresses it already has), reads it (`lib/unzip.js`, every file's CRC-32 checked), **refuses** a package that is not newer, has another `key`, or asks for more permissions / addresses (`checkCompatible` — that one is a manual update), writes the files with the manifest last, removes files that are gone, and calls `chrome.runtime.reload()`. The ID does not change (same key), so the stored connection survives. Without the File System Access API (or when refused) the manual way stays: download the zip, unzip over the folder, *Reload*. Not verifiable in the automated test: the native folder picker (unit tests cover the zip reader, the compatibility check and the writer on an in-memory folder).

## 1. Features

| # | Feature | Notes |
|---|---|---|
| 1 | **Send to Aigentron** | page / selection / link / screenshot (visible area, element, marked rectangle) → a **task** in the chosen project for the chosen agent, or → **a message in an existing task** (pick it in the list, or open the page from the side panel's conversation with «📷 Screenshot»: the picture, marks included, is saved among that task's files and the message names it), or → the project's **knowledge base** (clean text + URL). Context menu, toolbar popup, hotkey. |
| 2 | **Approvals and questions on the current page** | a card over the page the person is on (see §4), badge count, notification fallback, sound, `ask_user` buttons. Counts as "someone is in front of the dashboard" for the 10 s rule. |
| 3 | **Side panel** | chat with the admin / PM / any agent (the page text can ride along as context), task list with statuses, open a task. |
| 4 | **Bug report** | screenshot + URL + console errors + failed requests + viewport + the picked element (selector, computed styles) → one task for a frontend agent. |
| 5 | **Voice** | dictation (the microphone works in an extension without HTTPS on the server). Uses Settings → Voice (cloud or the local add-on). |
| 6 | **Agent control of the browser** | agents navigate, search, read pages, click, type and help fill forms in the person's real browser — see §5. |

**Project picker**: popup, side panel and the "send" card show a project list (`/api/projects`), remember the last choice, and can remember a project **per site**
("github.com → Aigentron"). The agent defaults to the project's default agent (already built). Context menu: "Send to ▸" the five latest projects.

## 2. Pieces

```
apps/extension/            TypeScript, built with esbuild/Vite → dist/ → aigentron-extension-<version>.zip
  manifest.json            MV3 TEMPLATE; permissions: storage, activeTab, scripting, contextMenus, notifications, alarms, sidePanel, offscreen;
                           host_permissions + content-script matches are written per server when the zip is generated; NO <all_urls>
  src/background/          service worker: the only code that talks to the server (token never reaches a page)
  src/content/             overlay (approvals, element picker, page capture); a closed Shadow DOM
  src/popup/, src/panel/   UI (React; types from @lds/shared)
  src/offscreen/           sound, microphone, a long-lived WebSocket if the service worker needs a keeper

apps/orchestrator/src/extension/   pairing + tokens + scopes, `/api/extension/*`, the WebSocket namespace, the browser-control MCP server
apps/dashboard/                    Add-ons → Extension: download the zip, install steps, "Connect" (pairing code / QR), connected browsers
```

Why the service worker does all network: pages and content scripts must never hold the token, and an extension with a host permission is not subject to CORS.
Real time: a WebSocket to the server (Chrome ≥ 116 keeps the worker alive while messages flow), `chrome.alarms` polling every minute as the fallback.

## 3. Delivery, server address and authorisation (revised 2026-11-02)

**Principle: the site is the source of truth.** The person never types an address, a code or a password into the extension: the extension is generated *for this server*, and the
dashboard — where they are already signed in (password, 2FA, Cloudflare Access) — hands the authorisation to it.

**Delivery — a per-server zip, built by the server, with no secrets in it**

- The release ships a ready-built **extension template** (`apps/extension` built in the release step, included in the image / tarball). The server does **not** compile anything at run time: on
  `GET /api/extension/download` (Add-ons → Extension → *Download for this server*, any signed-in role) it takes the template, **rewrites `manifest.json` and a `config.json`** for this instance and streams a zip.
- What is generated per server: the **name** (*Aigentron — example.com*), the **`host_permissions` and the content-script `matches` of this server's addresses only** (all domains the server is
  reachable on: the public domain, `localhost`, the LAN name — taken from the web-server / access settings), the version, and a **`key`** (the public half of a per-server key pair kept in the secrets dir) so the
  extension **ID is stable** for this server across updates and re-downloads (the same unpacked folder keeps its stored login when it is reloaded; two servers have two IDs and can both be installed).
- Permissions are granted at install (only these origins) — no runtime prompt, no `<all_urls>`.
- **Nothing secret is in the zip** (no token, no code): it is an artifact of the *address*, safe to keep in Downloads or send to a colleague, who still has to sign in to the dashboard.
- Install: unzip, `chrome://extensions` → Developer mode → *Load unpacked*. The Settings page shows exactly these steps with the folder name.

**Authorisation — its own identifier for the server, set up by a handshake with the open dashboard page** (revised 2026-11-02)

The extension does not depend on the sign-in system. It gets a **device credential** of its own (`ext_<id>_<secret>`; the server keeps only a hash, in `secrets/extension-devices.json`):

1. The extension has a content script on the server's own origin (the baked `matches`). When a dashboard page loads it announces itself (a `postMessage`); the dashboard shows a banner **"The Aigentron extension is installed — Connect"**
   (or the *Connect* button in Add-ons → Extension).
2. One click: the dashboard asks `POST /api/extension/pair` for a one-use code (60 s) and hands it to the extension over the content-script bridge (`window.postMessage` ↔ `chrome.runtime`; origin-checked, only that message type).
   The **domain comes from the page's own origin**, so another site cannot spoof it.
3. The extension's worker exchanges the code at `POST /api/extension/token` for the device token (stored in `chrome.storage.local`, never `sync`).
4. **With a sign-in password set**, only a signed-in person can press Connect (2FA and Cloudflare Access are inherited from that open tab) and the extension **acts as that person** (their role caps what it may do). **Without a password** (a local run) nothing is needed:
   the server is open anyway, the extension is bound to the **address** it was generated for, and acts as the default operator.
5. The device is listed in Add-ons → Extension (*Connected browsers*) and **Disconnect** works at once; the extension's own *Disconnect* does the same. Idle 180 days → it stops working (every call renews it). A password change or "sign out everywhere" does **not** end it
   (it is a separate credential) — disconnect it from that list.
6. The guard lets a device token reach **only its own short allow-list of routes** (`me`, `revoke`, `clip`, `health`, `GET projects / agents / knowledge` …), whatever its user's role would allow.
7. A revoked / forgotten device → the extension shows **Reconnect**, which opens the dashboard (one click on the banner).

**Updates**: the extension reports its version at the handshake; the dashboard compares it with the template version and shows *"update available — download"*. The new zip has the same key, so replacing the folder
and pressing *Reload* keeps the connection.

**Changed address**: the zip lists the domains the server knows. A new domain → download again (the key, and so the ID, stay the same while the secrets are carried over by `aigentron export/import`).

Personal API tokens for scripts can come later from the same machinery.

## 4. Approvals on the current page

- On `approval.created` / `question.created` the worker asks the **active tab of the focused window** to show a card (content script, `<dialog>` in the top layer inside a closed Shadow DOM, so the page's CSS and scripts
  cannot restyle or reach it). Several requests queue in one card.
- The card shows: the project and task, the tool, a one-line summary and the reason (the same text as the dashboard), **Approve / Deny**, and *Open in dashboard*.
- **Click-safety**: a button reacts only to a **trusted** click (`event.isTrusted` — a page script cannot synthesise one), is enabled ~400 ms after the card is shown (no click-jacking by a page
  that moves under the cursor), and the card closes at once when the request is resolved elsewhere (`approval.resolved` — Telegram, dashboard, another browser; the server decides atomically, first wins).
- **Never decided from the page**: the "hard" and guarded requests (credentials / protected files, main-branch, merges, outside the working directory, admin proposals that change the platform).
  The card shows them read-only with *Open in dashboard*. The token needs `approvals:decide`, and the server refuses hard decisions to an extension token anyway.
- Pages where a content script cannot run (`chrome://`, the Web Store, the built-in PDF viewer, new-tab page): the **notification** with Approve / Deny buttons (hard ones: Open) and the badge.
- Questions (`ask_user`): the options as buttons, a text field for a free answer, an image when the agent attached one.
- Sound: the same synth sounds / the person's own sounds (an offscreen document plays them). The extension reports presence ("the browser is in front") so the 10 s dashboard-first delay keeps working with only the extension open.

## 5. Agent control of the real browser

The agent gets browser tools through an **MCP server of the orchestrator** (`browser-ext`: `tabs_list`, `open`, `navigate`, `search`, `snapshot`, `read_text`, `screenshot`, `click`, `type`, `select`,
`scroll`, `wait`, `fill_form`, `highlight`), listed only when an extension with the `browser:control` scope is connected and the agent has `browser-ext` in its `mcp:` list. The orchestrator relays each call over the extension's WebSocket.

How the extension acts: `chrome.scripting` + a content script build an **accessibility-style snapshot** (roles, names, values, short refs — like the Playwright MCP snapshot, so the agent
"sees" the page as a list of elements, not pixels), and act on refs. `chrome.tabs.captureVisibleTab` for screenshots. Typing goes through the native value setter + `input`/`change` events (frameworks like React see it).
`chrome.debugger` (trusted input events) is a **per-tab fallback**, off by default (Chrome shows its "being debugged" bar, which is also a good transparency signal when it is used).

**Safety model** (the part that decides whether this is acceptable):

- **Its own tab group.** The agent works in tabs it opened (group "Aigentron") or tabs the person explicitly **shares** (toolbar toggle "Let the agent use this tab"). It never sees other tabs, history, bookmarks, cookies, local storage or saved passwords.
- **Per-site grants.** A new domain → an **approval card** (§4): *"Agent X wants to open example.com — read / interact / fill forms"*, answer once or "always for this site" (stored in the extension, revocable in its settings). A **deny-list** of sensitive domains (banks, payment pages, password managers, the mail / identity providers) is refused outright; the list is editable but starts non-empty.
- **Forms.** The agent proposes values, the extension fills them and **highlights** every filled field. It never fills password / card fields. **Submitting** (a submit button, `Enter` in a form, anything that looks like pay / order / delete / send / sign) is a separate approval card showing the target and the values — the agent cannot press it by itself. Autofill of the person's own saved data (profile fields) is a later option with its own switch.
- **Prompt injection.** Everything read from a page is returned to the agent as **untrusted data** (the existing policy). An action that leaves the current site (navigation to another domain, a form posting elsewhere, `window.open`) needs a new grant; page text cannot grant anything.
- **Visible and stoppable.** A coloured frame / banner on a controlled tab ("Agent is working — Stop"), a toolbar **Stop** button, automatic pause when the person types or clicks in that tab, one controller at a time (a lock), and a **log of every action** written into the task's conversation.
- **Search.** `search` opens the person's search engine in the agent's tab (the engine is a setting) and reads the results through the snapshot; for plain research the server-side tools (`web_fetch`, the research cache) stay cheaper.
- Relation to the existing browsers: the **Browser add-on** (a separate Chromium on the server, a person watches it by VNC) and **Playwright** (headless, throw-away) stay; this is "your own browser, your own logins, under grants".

## 6. Server work

- `ExtensionModule`: the **zip generator** (template + per-server `manifest.json` / `config.json` / `key`, a small zip writer — no build tools at run time), pairing codes (60 s, one use, bound to the signed-in user), token issue (`AuthSession` kind `extension` + scopes), `/api/extension/{pair,token,me,download,version}`. The release pipeline builds the template and ships it in the image / tarball.
- Auth guard: accepts the extension bearer token (already supported for the console client), enforces scopes, refuses hard approval decisions to it, records the device.
- `POST /api/clip` (page → task or KB note with attachments: screenshot, text) reusing the task / KB services and the project / agent defaults.
- WebSocket namespace for the extension: the same events as the dashboard (`approval.*`, `question.*`, `task.*`), presence, and the browser-control request / response channel.
- The `browser-ext` MCP server + a classifier rule set for it (new domain / interaction on an external page → approval; reads on a granted site free).
- Dashboard: **Add-ons → Extension** (*Download for this server*, install steps for developer mode, the *Connect* banner / button, connected browsers with revoke, the deny-list default); the page-side half of the handshake.
- Updates: a developer-mode extension does not update itself — the extension compares its version with `/api/extension/version` and shows "update available" with the link to the new zip.
- Docs, admin skill, tests (pairing, scopes, hard-approval refusal, the control relay with a fake extension).

## 7. Stages

| Stage | Content | Size |
|---|---|---|
| **E0 Foundation** | extension template + release build step, the zip generator (manifest / config / key), handshake with the dashboard page, token + scopes, Settings → Extension (download, steps, devices), project list | 1–1.5 weeks |
| **E1 Capture** | send page / selection / link / screenshot (marked) as a task or to the KB; project + agent picker, per-site project; context menu | 1 week |
| **E2 Approvals** | page card, queue, notification fallback, badge, sound, presence, questions | 1 week |
| **E3 Panel and reports** | side panel (chat, tasks), bug report (console / network / element), voice | 1–1.5 weeks |
| **E4a Control: read** | `browser-ext` MCP, tab group, per-site grants, snapshot / read / screenshot / navigate / search, Stop + log | 1.5 weeks |
| **E4b Control: act** | click / type / select / scroll, forms with highlight and submit approval, deny-list, debugger fallback | 1.5 weeks |

Order E0 → E1 → E2 → E3 → E4a → E4b; each stage is usable on its own.

## 8. Risks and open points

- **Developer-mode install**: Chrome may show a startup notice for unpacked extensions (mostly on Windows); updates are manual. A later unlisted Chrome Web Store entry removes both.
- **MV3 service worker lifetime**: WebSocket keep-alive + alarm fallback + an offscreen document where a long-lived page is needed.
- **Trusted input**: some sites ignore script-made clicks / typing; that is what the per-tab debugger fallback is for.
- **Click-jacking and spoofing of the card**: closed Shadow DOM, top layer, `isTrusted`, delay, no hard decisions from the card.
- **Privacy**: page content leaves the browser only on an explicit action (send / ask / a granted agent session); a site exclusion list; a clear "what was sent" line in the card.
- **Scope of control** stays the main safety decision: starting with the dedicated tab group + per-site grants + deny-list; widening it is a conscious later step.
