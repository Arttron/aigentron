// Browser control: what an agent may do in the person's own browser, as commands from the server (`ext:command`). Everything happens in a SEPARATE window
// (its tabs grouped "Aigentron"), never in the person's tabs unless they shared one; every address is checked against the never-allowed list and the sites the
// server says this task may use; a frame with a Stop button shows in every tab the agent works in.
import { actInPage, agentFrame, readPage, snapshotPage } from './agentpage.js';
import { deniedReason, webUrl } from './policy.js';
import { getConfig } from './store.js';

const KEY = 'agentState';
const FRAME_IDLE_MS = 20_000;
const frameTimers = new Map();
// a Stop must survive the service worker being unloaded: it lives in the session storage, not in a variable
const STOP_KEY = 'agent-stopped-at';
const stoppedAtOf = async () => (await chrome.storage.session.get(STOP_KEY))[STOP_KEY] ?? 0;
const isStopped = async () => Date.now() - (await stoppedAtOf()) < 10 * 60_000;

async function load() {
  const { [KEY]: s } = await chrome.storage.session.get(KEY);
  return { windowId: null, groupId: null, tabs: [], shared: [], ...(s ?? {}) };
}
const save = (s) => chrome.storage.session.set({ [KEY]: s });

/** Hosts the agent must never touch: the NEVER list plus this server's own addresses. */
async function own(args) {
  const cfg = await getConfig();
  return [...new Set([...(args.ownOrigins ?? []), ...cfg.origins])];
}

const hostOf = (url) => webUrl(url)?.host ?? '';

/** The tab the command names, if the agent may use it at all (its own, or one the person shared). */
async function usableTab(args) {
  const s = await load();
  const id = Number(args.tabId);
  if (!Number.isInteger(id) || !(s.tabs.includes(id) || s.shared.includes(id))) throw new Error(`Tab ${args.tabId} is not one of yours. Use browser_tabs to see the tabs you can use.`);
  const tab = await chrome.tabs.get(id).catch(() => null);
  if (!tab) throw new Error(`Tab ${id} was closed.`);
  return tab;
}

/** May the page in this tab be read for this command? Never-allowed → an error; a site the task was not granted → `needsGrant`. */
async function gate(tab, args, level = 'read') {
  const w = webUrl(tab.url);
  if (!w) throw new Error('This tab is not showing a web page.');
  const bad = deniedReason(w.url, await own(args));
  if (bad) throw new Error(`Not allowed: ${bad}.`);
  const allow = args.allow ?? { read: args.allowHosts ?? [], interact: [] };
  if (!(allow[level] ?? []).includes(w.key)) return { needsGrant: w.key, needsUrl: w.url.toString(), level, tabId: tab.id };
  return null;
}

async function waitLoaded(tabId, ms = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error('The tab was closed.');
    if (t.status === 'complete') return t;
    if (Date.now() - t0 > ms) return t; // slow page: work with what is there
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function ensureWindowTab(url) {
  const s = await load();
  let win = s.windowId ? await chrome.windows.get(s.windowId).catch(() => null) : null;
  let tab;
  if (!win) {
    win = await chrome.windows.create({ url, focused: false, type: 'normal', width: 1100, height: 800 });
    s.windowId = win.id;
    s.groupId = null;
    tab = win.tabs[0];
  } else {
    tab = await chrome.tabs.create({ windowId: win.id, url, active: true });
  }
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(s.groupId ? { groupId: s.groupId } : { createProperties: { windowId: win.id } }) });
    s.groupId = groupId;
    await chrome.tabGroups.update(groupId, { title: 'Aigentron', color: 'blue' });
  } catch {
    /* a browser without tab groups: the separate window is the boundary anyway */
  }
  s.tabs = [...new Set([...s.tabs, tab.id])];
  await save(s);
  return tab;
}

function frame(tabId) {
  void chrome.scripting.executeScript({ target: { tabId }, func: agentFrame, args: [true] }).catch(() => undefined);
  clearTimeout(frameTimers.get(tabId));
  frameTimers.set(tabId, setTimeout(() => void chrome.scripting.executeScript({ target: { tabId }, func: agentFrame, args: [false] }).catch(() => undefined), FRAME_IDLE_MS));
}

const inTab = async (tabId, func, args = []) => {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r?.result;
};

/** Downscale a screenshot to at most 1280 px wide and encode it as JPEG (what goes back to the model). */
async function jpeg(dataUrl) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = Math.min(1, 1280 / bmp.width);
  const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** An action on the page → the page afterwards. Checked first (never-allowed, granted for `interact`), done in the page, then the new page is checked again (a click may have navigated). */
async function act(kind, args) {
  const tab = await usableTab(args);
  const need = await gate(tab, args, 'interact');
  if (need) return { ok: false, needsGrant: need.needsGrant, needsUrl: need.needsUrl, level: 'interact', error: 'clicking and typing on this site is not allowed yet', data: { tabId: tab.id } };
  frame(tab.id);
  let r = await inTab(tab.id, actInPage, [{ kind, ...args }]);
  if (r?.goesTo) {
    // a link / form that leaves this site: the destination is judged BEFORE the click, like an address given to `navigate`
    const w = webUrl(r.goesTo);
    if (!w) throw new Error('That link does not lead to a web page.');
    const bad = deniedReason(w.url, await own(args));
    if (bad) throw new Error(`Not allowed: ${bad}.`);
    const allow = args.allow ?? { read: args.allowHosts ?? [], interact: [] };
    if (!(allow.read ?? []).includes(w.key)) return { ok: false, needsGrant: w.key, needsUrl: w.url.toString(), level: 'read', error: 'the link leads to a site that is not allowed yet', data: { tabId: tab.id } };
    r = await inTab(tab.id, actInPage, [{ kind, ...args, checked: true }]);
  }
  if (!r?.ok) return r?.needsSubmit ? { ok: false, needsSubmit: r.needsSubmit, error: 'the person has to approve this', data: { tabId: tab.id } } : { ok: false, error: r?.error ?? 'The page did not answer.' };
  await new Promise((res) => setTimeout(res, 600));
  const after = await waitLoaded(tab.id);
  const need2 = await gate(after, args, 'read');
  if (need2) return { ok: false, needsGrant: need2.needsGrant, needsUrl: need2.needsUrl, level: 'interact', error: 'the page moved to a site that is not allowed yet', data: { tabId: tab.id, performed: true } };
  const snap = await inTab(tab.id, snapshotPage);
  return { ok: true, data: { tabId: tab.id, ...snap } };
}

const COMMANDS = {
  async tabs() {
    const s = await load();
    const out = [];
    for (const id of [...s.tabs, ...s.shared]) {
      const t = await chrome.tabs.get(id).catch(() => null);
      if (t) out.push({ id, title: t.title ?? '', url: t.url ?? '' });
    }
    return { ok: true, data: { tabs: out } };
  },

  async open(args) {
    const w = webUrl(args.url);
    if (!w) throw new Error('That is not a web address.');
    const bad = deniedReason(w.url, await own(args));
    if (bad) throw new Error(`Not allowed: ${bad}.`);
    if (!((args.allow?.read ?? args.allowHosts) ?? []).includes(w.key)) return { ok: false, needsGrant: w.key, needsUrl: w.url.toString(), error: 'not granted' };
    const tab = await ensureWindowTab(w.url.toString());
    const done = await waitLoaded(tab.id);
    return COMMANDS.snapshot({ ...args, tabId: done.id });
  },

  async navigate(args) {
    const tab = await usableTab(args);
    const w = webUrl(args.url);
    if (!w) throw new Error('That is not a web address.');
    const bad = deniedReason(w.url, await own(args));
    if (bad) throw new Error(`Not allowed: ${bad}.`);
    if (!((args.allow?.read ?? args.allowHosts) ?? []).includes(w.key)) return { ok: false, needsGrant: w.key, needsUrl: w.url.toString(), error: 'not granted' };
    await chrome.tabs.update(tab.id, { url: w.url.toString() });
    const done = await waitLoaded(tab.id);
    return COMMANDS.snapshot({ ...args, tabId: done.id });
  },

  async snapshot(args) {
    const tab = await usableTab(args);
    const need = await gate(tab, args);
    if (need) return { ok: false, needsGrant: need.needsGrant, needsUrl: need.needsUrl, data: { tabId: tab.id }, error: 'the tab is on a site that is not granted' };
    frame(tab.id);
    const r = await inTab(tab.id, snapshotPage);
    return { ok: true, data: { tabId: tab.id, ...r } };
  },

  async read(args) {
    const tab = await usableTab(args);
    const need = await gate(tab, args);
    if (need) return { ok: false, needsGrant: need.needsGrant, needsUrl: need.needsUrl, data: { tabId: tab.id }, error: 'the tab is on a site that is not granted' };
    frame(tab.id);
    const r = await inTab(tab.id, readPage, [args.offset ?? 0, 12000]);
    return { ok: true, data: { tabId: tab.id, ...r } };
  },

  async screenshot(args) {
    const tab = await usableTab(args);
    const need = await gate(tab, args);
    if (need) return { ok: false, needsGrant: need.needsGrant, needsUrl: need.needsUrl, data: { tabId: tab.id }, error: 'the tab is on a site that is not granted' };
    frame(tab.id);
    await chrome.tabs.update(tab.id, { active: true }); // the active tab OF ITS OWN window: the person's window is not touched
    const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { ok: true, data: { tabId: tab.id, image: await jpeg(png) } };
  },

  // ---- acting on a page (interact level) ----
  async click(args) {
    return act('click', args);
  },
  async type(args) {
    return act('type', args);
  },
  async select(args) {
    return act('select', args);
  },
  async press(args) {
    return act('press', args);
  },
  async scroll(args) {
    return act('scroll', args);
  },

  async close(args) {
    const tab = await usableTab(args);
    await chrome.tabs.remove(tab.id);
    const s = await load();
    s.tabs = s.tabs.filter((t) => t !== tab.id);
    await save(s);
    return { ok: true, data: {} };
  },
};

/** One command from the server → the answer to send back (never throws). */
export async function handleCommand(cmd) {
  const fn = COMMANDS[cmd?.tool];
  if (!fn) return { ok: false, error: `The extension does not know the command "${cmd?.tool}".` };
  if (await isStopped()) return { ok: false, error: 'The person pressed Stop.' };
  try {
    return await fn(cmd.args ?? {});
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The person pressed Stop (the frame's button or the popup): frames go away, new commands are refused for ten minutes. */
export async function stopAgent() {
  await chrome.storage.session.set({ [STOP_KEY]: Date.now() });
  const s = await load();
  for (const id of s.tabs) void chrome.scripting.executeScript({ target: { tabId: id }, func: agentFrame, args: [false] }).catch(() => undefined);
}

export const allowAgent = () => chrome.storage.session.remove(STOP_KEY);

/** Let the agent use the tab the person is on (or take it back). */
export async function toggleShare(tabId) {
  const s = await load();
  const on = !s.shared.includes(tabId);
  s.shared = on ? [...s.shared, tabId] : s.shared.filter((t) => t !== tabId);
  await save(s);
  return on;
}

export async function agentStatus(activeTabId) {
  const s = await load();
  return { windowOpen: Boolean(s.windowId), tabs: s.tabs.length, shared: s.shared.length, thisShared: s.shared.includes(activeTabId), stopped: await isStopped() };
}

export function watchTabs() {
  chrome.tabs.onRemoved.addListener(async (id) => {
    const s = await load();
    if (s.tabs.includes(id) || s.shared.includes(id)) {
      s.tabs = s.tabs.filter((t) => t !== id);
      s.shared = s.shared.filter((t) => t !== id);
      await save(s);
    }
  });
  chrome.windows.onRemoved.addListener(async (wid) => {
    const s = await load();
    if (s.windowId === wid) await save({ ...s, windowId: null, groupId: null, tabs: [] });
  });
}
