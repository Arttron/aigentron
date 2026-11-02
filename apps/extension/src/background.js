// Service worker: the only part of the extension that talks to the server (the token never reaches a page).
import { ApiError, apiFetch, exchangeCode } from './lib/api.js';
import { extractPageInPage } from './lib/capture.js';
import { collectReport, installRecorder, peekRecorder, pickElement } from './lib/bugpage.js';
import { getConfig, getConnection, setConnection } from './lib/store.js';
import { agentStatus, toggleShare } from './lib/agent.js';
import { updateAvailable } from './lib/version.js';
import { ensure as ensureInbox, inboxHandlers, startInbox } from './lib/inbox.js';

/** "Chrome on macOS" — shown in the server's list of sessions. */
function deviceLabel() {
  const ua = navigator.userAgentData;
  const brand = ua?.brands?.find((b) => !/not.?a.?brand|chromium/i.test(b.brand))?.brand ?? (/Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome');
  const platform = ua?.platform || (/Mac/.test(navigator.userAgent) ? 'macOS' : /Win/.test(navigator.userAgent) ? 'Windows' : /Linux/.test(navigator.userAgent) ? 'Linux' : '');
  return platform ? `${brand} on ${platform}` : brand;
}

async function status() {
  const conn = await getConnection();
  const cfg = await getConfig();
  return {
    connected: Boolean(conn) && !conn.needsReconnect,
    needsReconnect: Boolean(conn?.needsReconnect),
    user: conn?.user ?? null,
    origin: conn?.origin ?? null,
    serverVersion: conn?.serverVersion ?? null,
    serverName: cfg.serverName,
    origins: cfg.origins,
    version: chrome.runtime.getManifest().version,
    update: await updateInfo(),
  };
}

/** Ask the server which extension version it ships and remember it (the popup and the panel show «update available» from this). */
async function refreshOffered() {
  try {
    const m = await apiFetch('/api/extension/me');
    await chrome.storage.local.set({ offered: m.extensionVersion ?? null });
  } catch {
    /* not connected / offline: keep what we knew */
  }
}

/** The version the server offers, remembered by the periodic check (null = none known / up to date). */
async function updateInfo() {
  const { offered } = await chrome.storage.local.get('offered');
  const installed = chrome.runtime.getManifest().version;
  return updateAvailable(installed, offered) ? { installed, available: offered } : null;
}

/** "!" while the login is gone; otherwise the inbox shows its own count (it re-draws the badge). */
function badge(needsReconnect) {
  if (needsReconnect) {
    void chrome.action.setBadgeText({ text: '!' });
    void chrome.action.setBadgeBackgroundColor({ color: '#d33' });
  } else void ensureInbox();
}

/** The dashboard page handed a pairing code to the content script. */
async function pair(msg, sender) {
  const cfg = await getConfig();
  const pageOrigin = sender.tab?.url ? new URL(sender.tab.url).origin : null;
  // only this server's own pages (the manifest already limits the content script to them), and an API address that is one of the package's
  if (!pageOrigin || pageOrigin !== msg.pageOrigin || !cfg.origins.includes(pageOrigin)) throw new ApiError(403, 'This page is not one of the server addresses of this extension');
  const apiOrigin = cfg.origins.includes(msg.apiOrigin) ? msg.apiOrigin : pageOrigin;
  const r = await exchangeCode(apiOrigin, msg.code, deviceLabel());
  await setConnection({ origin: apiOrigin, token: r.token, user: r.user, serverVersion: r.serverVersion, connectedAt: new Date().toISOString() });
  badge(false);
  void ensureInbox();
  void refreshOffered();
  return { ok: true, user: r.user, serverVersion: r.serverVersion };
}

async function disconnect() {
  try {
    await apiFetch('/api/extension/revoke', { method: 'POST' });
  } catch {
    /* already ended, or the server is away: the local forget below is what matters */
  }
  await setConnection(null);
  badge(false);
  void ensureInbox();
  return { ok: true };
}

// ---- "Send to Aigentron": capture → a draft → the compose page --------------------------------------------------------------------
const WEB = /^https?:\/\//i;

/**
 * Captures what is on a tab (the title, the selection, the readable text, a screenshot) into a draft kept in session storage, and opens the compose page.
 * Runs on a person's action (toolbar button, menu, shortcut): that is what grants access to the tab (`activeTab`).
 */
async function startCompose({ tab, kind, info, open = true }) {
  if (!tab?.id) throw new ApiError(0, 'There is no page to send');
  const draft = { id: crypto.randomUUID(), kind, tabId: tab.id, linkUrl: info?.linkUrl ?? '', screenshot: null, createdAt: Date.now(), ...(await capturePage(tab, info?.selectionText)) };
  try {
    if (WEB.test(draft.url)) draft.screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch {
    /* no screenshot (a page that does not allow it, or no permission) — the rest still works */
  }
  await chrome.storage.session.set({ [`draft:${draft.id}`]: draft });
  if (open) await chrome.tabs.create({ url: chrome.runtime.getURL(`compose.html?draft=${draft.id}`) });
  return { ok: true, id: draft.id };
}

/** The title, address, selection and readable text of a tab (what the extension may read there; a note says what it could not). */
async function capturePage(tab, selectionFallback = '') {
  const out = { url: tab.url ?? '', title: tab.title ?? '', selection: '', text: '', note: '' };
  if (!WEB.test(out.url)) {
    out.note = 'This kind of page cannot be read by an extension (browser pages, the Web Store, local files). Only a note can be sent.';
    return out;
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageInPage });
    Object.assign(out, { title: result.title || out.title, url: result.url || out.url, selection: result.selection || selectionFallback, text: result.text });
  } catch (e) {
    out.selection = selectionFallback;
    out.note = `The page text could not be read (${e.message}). Click the extension icon on that page first.`;
  }
  return out;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---- "Report a bug": record console / network problems on ONE tab while the person reproduces it, optionally point at an element ---------------------
async function bugTab(msg) {
  let tab;
  if (typeof msg.tabId === 'number') tab = await chrome.tabs.get(msg.tabId).catch(() => null);
  else if (typeof msg.find === 'string') [tab] = (await chrome.tabs.query({ url: msg.find })).filter((t) => !t.url?.startsWith('chrome-extension://'));
  else tab = await activeTab();
  if (!tab?.id || !WEB.test(tab.url ?? '')) throw new ApiError(0, 'Open the page with the problem first (a web page, not a browser page).');
  return tab;
}
const inPage = async (tabId, func, world = 'MAIN') => {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world, func });
    return r?.result;
  } catch (e) {
    throw new ApiError(0, `The extension cannot reach that page (${e.message}). Click the extension icon on it first, or allow “Show cards on any page” in the popup.`);
  }
};

const bugHandlers = {
  'bug-start': async (msg) => {
    const tab = await bugTab(msg);
    await inPage(tab.id, installRecorder);
    return { ok: true, tabId: tab.id, url: tab.url, title: tab.title };
  },
  'bug-peek': async (msg) => ({ ok: true, ...(await inPage((await bugTab(msg)).id, peekRecorder)) }),
  'bug-pick': async (msg) => ({ ok: true, element: await inPage((await bugTab(msg)).id, pickElement, 'ISOLATED') }),
  'bug-finish': async (msg) => {
    const tab = await bugTab(msg);
    const report = await inPage(tab.id, collectReport);
    const draft = { id: crypto.randomUUID(), kind: 'bug', tabId: tab.id, url: tab.url, title: tab.title ?? '', selection: '', text: '', linkUrl: '', screenshot: null, note: '', createdAt: Date.now(), bug: { console: report.console, network: report.network, errors: report.errors, env: report.env, ...(msg.element ? { element: msg.element } : {}) } };
    if (!report.recorded) draft.note = 'Recording was not running on this page (it stops when the page reloads), so only what was already visible is included.';
    try {
      draft.screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch {
      /* no screenshot without the permission */
    }
    await chrome.storage.session.set({ [`draft:${draft.id}`]: draft });
    if (msg.open !== false) await chrome.tabs.create({ url: chrome.runtime.getURL(`compose.html?draft=${draft.id}`) });
    return { ok: true, id: draft.id };
  },
};

const MEMORY_KEY = 'composeMemory';
async function memoryGet() {
  const { [MEMORY_KEY]: m } = await chrome.storage.local.get(MEMORY_KEY);
  return m ?? { site: {}, last: '' };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'send-page', title: 'Send this page to Aigentron', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'send-selection', title: 'Send the selection to Aigentron', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'send-link', title: 'Send this link to Aigentron', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'send-screenshot', title: 'Screenshot this page to Aigentron', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'open-panel', title: 'Open the Aigentron panel', contexts: ['page'] });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-panel') return void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  const kind = { 'send-page': 'page', 'send-selection': 'selection', 'send-link': 'link', 'send-screenshot': 'screenshot' }[info.menuItemId];
  if (kind) void startCompose({ tab, kind, info }).catch((e) => console.warn('compose failed', e));
});
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'open-panel') return void chrome.sidePanel.open({ windowId: (tab ?? (await activeTab()))?.windowId }).catch(() => undefined);
  if (command === 'send-page') void startCompose({ tab: tab ?? (await activeTab()), kind: 'page' }).catch((e) => console.warn('compose failed', e));
});

const handlers = {
  ...inboxHandlers,
  ...bugHandlers,
  'compose-start': async (msg) => {
    // `find`: the tab whose address matches a pattern (a deep link / tests); otherwise the active tab of the current window
    let tab;
    if (typeof msg.find === 'string') [tab] = (await chrome.tabs.query({ url: msg.find })).filter((t) => !t.url?.startsWith('chrome-extension://'));
    else tab = await activeTab();
    return startCompose({ tab, kind: ['page', 'selection', 'link', 'screenshot'].includes(msg.kind) ? msg.kind : 'page', open: msg.open !== false });
  },
  agents: async () => ({ agents: await apiFetch('/api/agents') }),
  'agent-status': async () => {
    const tab = await activeTab();
    return { ok: true, ...(await agentStatus(tab?.id)), activeTabId: tab?.id ?? null, activeUrl: tab?.url ?? '' };
  },
  'agent-share': async () => {
    const tab = await activeTab();
    if (!tab?.id || !WEB.test(tab.url ?? '')) throw new ApiError(0, 'Open a web page first.');
    return { ok: true, shared: await toggleShare(tab.id) };
  },
  'open-mic': async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
    return { ok: true };
  },
  'capture-active': async () => {
    const tab = await activeTab();
    if (!tab?.id) return { ok: false, error: 'There is no page to read' };
    const c = await capturePage(tab);
    return c.text || c.selection ? { ok: true, ...c } : { ok: false, error: c.note || 'There is nothing to read on this page' };
  },
  // the project's own knowledge bases and the global ones (every project may use those)
  kbs: async (msg) => {
    const [own, global] = await Promise.all([apiFetch(`/api/knowledge?project=${encodeURIComponent(String(msg.project ?? ''))}`), apiFetch('/api/knowledge?project=global')]);
    return { kbs: [...own, ...global.filter((g) => !own.some((o) => o.name === g.name)).map((g) => ({ ...g, global: true }))] };
  },
  'memory-get': async () => ({ memory: await memoryGet() }),
  clip: async (msg) => {
    const result = await apiFetch('/api/extension/clip', { method: 'POST', body: JSON.stringify(msg.body) });
    if (msg.remember?.site && msg.remember.project) {
      const m = await memoryGet();
      m.last = msg.remember.project;
      m.site[msg.remember.site] = msg.remember.project;
      const keys = Object.keys(m.site);
      if (keys.length > 200) delete m.site[keys[0]];
      await chrome.storage.local.set({ [MEMORY_KEY]: m });
    }
    return { ok: true, result };
  },
  status: () => status(),
  pair,
  disconnect,
  projects: async () => ({ projects: await apiFetch('/api/projects') }),
  open: async (msg) => {
    const cfg = await getConfig();
    const conn = await getConnection();
    const url = conn?.origin ?? cfg.origins[0];
    await chrome.tabs.create({ url: msg.path ? `${url}${msg.path}` : url });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // only this extension's own pages and content scripts
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string' || !(msg.type in handlers)) return false;
  Promise.resolve(handlers[msg.type](msg, sender))
    .then(respond)
    .catch((e) => respond({ ok: false, error: e instanceof Error ? e.message : String(e), status: e instanceof ApiError ? e.status : 0 }));
  return true; // answered asynchronously
});

// Is the token still good? (a revoked one shows a "!" badge and the popup offers Reconnect)
chrome.alarms.create('check', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'check' || !(await getConnection())) return;
  try {
    const r = await apiFetch('/api/extension/me');
    const conn = await getConnection();
    if (conn) await setConnection({ ...conn, user: r.user, serverVersion: r.serverVersion, needsReconnect: false });
    await chrome.storage.local.set({ offered: r.extensionVersion ?? null });
    badge(false);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) badge(true);
  }
});

chrome.runtime.onStartup.addListener(async () => badge(Boolean((await getConnection())?.needsReconnect)));

startInbox();
void refreshOffered();
