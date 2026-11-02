# Aigentron browser extension (Chromium, Manifest V3)

`src/` is the extension, `pnpm --filter @lds/extension build` validates it and writes the **template** to `dist/` (part of the project build). The server never builds anything and never serves the template as it is: `GET /api/extension/download` (Add-ons → Extension) copies `dist/` and rewrites only `manifest.json` (name, the
server's addresses in `host_permissions` and the content-script `matches`, `key`, version) and adds `config.json`, then streams a zip. Plan: `docs/plan-browser-extension.md`.

- `background.js` — service worker, the only code that talks to the server (token in `chrome.storage.local`).
- `content.js` — the bridge to the dashboard page for the **Connect** handshake (`postMessage` ↔ `chrome.runtime`).
- `popup.*` — the toolbar popup. Plain ES modules; a compile step (TypeScript, a bundled side panel) would be added in `build.mjs`, nothing else changes.

Development: *Load unpacked* `src/` (or `dist/`) against a local stack (the template allows `http://localhost/*`); the pairing needs a sign-in password set on the server.
Icons: `pnpm --filter @lds/extension icons`.
