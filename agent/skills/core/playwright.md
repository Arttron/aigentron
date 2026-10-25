---
name: playwright
description: Preview and visually review a running dev server using the `playwright` MCP browser server (navigate + screenshot + accessibility snapshot). Use when previewing a page, taking a screenshot, or visually reviewing a UI change.
---

# Skill: Playwright Preview (via the `playwright` MCP server)
**Applies to:** Designer, Reviewer, Frontend

To use this skill you must have the `playwright` MCP server in your `mcp:` list. It runs as a
separate browser service (compose service `playwright-mcp`, started with `--profile mcp`; on a server
without compose the Playwright add-on: `sudo aigentron addon enable playwright`), so its tools are
exposed to you as `mcp__playwright__*`. If the tools aren't available, the service isn't up — say so
in your status report (and which of the two fixes applies, if you can tell) rather than falling back to guessing. **Do not** try to
install or run Playwright yourself via Bash; if the MCP isn't there, report `blocked`.

**Preview target — your own worktree.** To see *your* in-progress changes (not the base app),
first call `mcp__lds_internal__preview_worktree` (no args). It starts an ephemeral dev server for
**this task's worktree** and returns a URL like `http://orchestrator:3200`; navigate the browser
there (use the URL exactly as returned: on a server with the add-on it is `localhost`, the browser being on the same machine). This is what you want when reviewing a change you just made. The server is torn down
automatically when the task finishes. (The target app must honor `$PORT` and bind `0.0.0.0`.)

**Base app (fallback).** The always-on `project-dev` service is a sample app of the Docker stack (the `./project` folder), not a registered project: it exists only on a Docker install
and only for the default project's stack. In any other project use `preview_worktree`; use `project-dev` (`http://project-dev:3080`) only when it is there and you explicitly want the
baseline. `localhost` is NOT correct in either case: from the browser container `localhost` is
itself, not the app.

> The browser runs in a separate container, not your worktree. A screenshot comes back to **you**
> in the tool result for analysis (you have vision) — it is not written into the project. Report
> what you see; don't assume a file was saved next to the code.

---

## Browsing through a proxy (`playwright-proxy`)

Some pages must be opened from another country or from an IP the site allows (geo-blocked content, a
site that rejects the server's address). For those there is a SECOND browser, `playwright-proxy`: the same
tools with ALL its traffic going through the operator's proxy. Use it only when the normal browser is
blocked or the task needs that egress IP — it is slower and the proxy may be metered.

- Add `playwright-proxy` to your `mcp:` list (Agents → Edit → MCP servers). Its tools are
  `mcp__playwright-proxy__browser_navigate`, `…__browser_snapshot`, `…__browser_take_screenshot`, … — the same
  names as above with the server name `playwright-proxy`.
- Which browser: local/dev URLs and anything that works directly → `playwright`. A public site that is blocked,
  rate-limited by IP or region-locked → `playwright-proxy`. Don't use the proxy browser for the project's own
  preview URLs (`preview_worktree`, `project-dev`) — the proxy cannot reach the internal network.
- Rules are the same: capture tools run freely; navigating to a non-local URL and clicking/typing go through the
  approval gate. Each browser keeps its own tabs and cookies; don't expect a login made in one to exist in the other.
- If the tools are missing or the first navigation fails with a proxy / connection error, report it in your status
  (`blocked`, with the error text) — do NOT try other proxies, and **never ask for or print the proxy login/password**
  (they live only in the server's `.env`; you never see them).
- Operator setup (once): put the proxy in the server's `.env` — `PLAYWRIGHT_PROXY_SERVER=host:port`,
  `PLAYWRIGHT_PROXY_USER=login`, `PLAYWRIGHT_PROXY_PASS=password` (optional `PLAYWRIGHT_PROXY_BYPASS=host1,host2`) — then
  `docker compose --profile proxy up -d playwright-mcp-proxy`. Details: `docs/browser-proxy.md`.

---

## Workflow

```
mcp__lds_internal__preview_worktree {}  → live URL for YOUR worktree (e.g. http://orchestrator:3200)
    ↓
mcp__playwright__browser_navigate → the page (the returned URL)
    ↓
mcp__playwright__browser_resize   → desktop, then mobile viewport
    ↓
mcp__playwright__browser_take_screenshot (each viewport)
    ↓
Analyze the returned image (+ browser_snapshot for structure) and iterate
```

## Tools you'll use

| Tool | Purpose |
|------|---------|
| `mcp__playwright__browser_navigate` | `{ url }` — open a page (use `http://project-dev:3080/...`). |
| `mcp__playwright__browser_resize` | `{ width, height }` — set the viewport (desktop `1440x900`, mobile `390x844`). |
| `mcp__playwright__browser_take_screenshot` | capture the current page; the image returns in the tool result for you to review. Pass `{ fullPage: true }` for the whole page, or `{ element, ref }` for one element. |
| `mcp__playwright__browser_snapshot` | accessibility tree of the page — better than a screenshot for checking structure, roles, and text. |
| `mcp__playwright__browser_console_messages` | read console errors/warnings when something looks broken. |
| `mcp__playwright__browser_click` / `browser_type` | drive a flow before screenshotting a state (e.g. open a modal, fill a form). |
| `mcp__playwright__browser_wait_for` | `{ text }` or `{ time }` — wait for content before capturing. |

Typical review of one page at two viewports:

```
browser_navigate { url: "http://project-dev:3080/demo" }
browser_resize   { width: 1440, height: 900 }   → browser_take_screenshot {}
browser_resize   { width: 390,  height: 844 }   → browser_take_screenshot {}
browser_snapshot {}                              # structure check
```

> Read-only browser tools — navigating to a **local** URL, resize, screenshot, snapshot,
> console/network, wait — run without approval. Page-mutating actions (`browser_click`,
> `browser_type`) and navigating to a **non-local** URL go through the approval gate. Keep calls
> tight — navigate once, capture the viewports you need, analyze; don't loop the same state.

## Rules for Designer

When reviewing a screenshot:
```
1. Does the overall layout match the task?
2. Check alignment and spacing.
3. Look for visual problems: text overflow, broken grid/flex, color mismatches, mobile
   viewport issues.
4. State concrete fixes.
```

### Output format after screenshot analysis
```
## Visual analysis

✅ What's working:
- [observation]

❌ Problems:
- [problem] → [concrete CSS Module / token fix]

🔧 Code changes:
[file and changed classes]

📸 Request another screenshot after fixes: YES/NO
```

## Rules for Reviewer

When reviewing a screenshot before approving:
- Content isn't clipped or overflowing
- Text is readable (contrast, size)
- Interactive elements are visible (buttons, links)
- Mobile: tap targets at least 44x44px
- No horizontal scroll on mobile
- Loading states are present
