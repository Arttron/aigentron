// The inbox: the requests agents are waiting on (approvals, questions), kept in step with the server over a Socket.IO connection, and shown where the
// person is — a card on the page they are looking at (when they allowed it), else a notification — with a badge and a sound.
import { ApiError, apiFetch } from './api.js';
import { allowAgent, handleCommand, stopAgent, watchTabs } from './agent.js';
import { buildCard, injectable, notificationText, orderItems, shouldPlaySound } from './cards.js';
import { SioClient, socketUrl } from './sio.js';
import { getConfig, getConnection } from './store.js';

const S = { approvals: new Map(), questions: new Map(), tasks: new Map(), seen: new Set(), client: null, clientToken: null, overlayTab: null, snoozeUntil: 0, front: null, ready: null };
const DEFAULT_PREFS = { sound: true, volume: 0.6, soundName: 'uhoh' };
const ALL_PAGES = { origins: ['<all_urls>'] };

export async function getPrefs() {
  const { prefs } = await chrome.storage.local.get('prefs');
  return { ...DEFAULT_PREFS, ...(prefs ?? {}) };
}

// ---- persistence (the service worker is stopped and started by the browser; the lists must survive that) ------------------------------
async function load() {
  S.ready ??= (async () => {
    const { inbox } = await chrome.storage.session.get('inbox');
    for (const a of inbox?.approvals ?? []) S.approvals.set(a.id, a);
    for (const q of inbox?.questions ?? []) S.questions.set(q.id, q);
    for (const [id, t] of Object.entries(inbox?.tasks ?? {})) S.tasks.set(id, t);
    for (const id of inbox?.seen ?? []) S.seen.add(id);
  })();
  return S.ready;
}
let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void chrome.storage.session.set({ inbox: { approvals: [...S.approvals.values()], questions: [...S.questions.values()], tasks: Object.fromEntries(S.tasks), seen: [...S.seen].slice(-300) } });
  }, 200);
}

// ---- the connection ----------------------------------------------------------------------------------------------------------------------
function stop() {
  S.client?.stop();
  S.client = null;
  S.clientToken = null;
}

/** (Re)open the connection when there is a usable login; close it when there is not. Safe to call any time. */
export async function ensure() {
  await load();
  const conn = await getConnection();
  if (!conn || conn.needsReconnect) {
    stop();
    S.approvals.clear();
    S.questions.clear();
    await render({ announce: false });
    return;
  }
  if (S.client && S.clientToken === conn.token) return;
  stop();
  S.clientToken = conn.token;
  S.client = new SioClient({
    url: socketUrl(conn.origin),
    auth: { token: conn.token, version: chrome.runtime.getManifest().version },
    onEvent,
    onState: (state, wasConnected) => {
      if (state === 'open') {
        void refresh();
        void reportPresence(true);
      } else if (state === 'closed' && !wasConnected) {
        // never got in: a revoked login looks like this — find out (a 401 marks the connection "needs reconnect") and stop retrying if so
        void apiFetch('/api/extension/me').catch(() => undefined).then(() => ensure());
      }
    },
  });
  S.client.start();
}

async function refresh() {
  try {
    const [approvals, questions] = await Promise.all([apiFetch('/api/approvals?status=pending'), apiFetch('/api/questions?status=pending')]);
    S.approvals = new Map(approvals.map((a) => [a.id, a]));
    S.questions = new Map(questions.map((q) => [q.id, q]));
    // what is already waiting when we (re)connect is not "new": no sound for it, but it is shown
    for (const id of [...S.approvals.keys(), ...S.questions.keys()]) S.seen.add(id);
    await learnTasks();
    await render({ announce: false });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) console.warn('inbox refresh failed', e);
  }
}

async function learnTasks() {
  const ids = new Set([...S.approvals.values(), ...S.questions.values()].map((x) => x.taskId));
  await Promise.all(
    [...ids]
      .filter((id) => !S.tasks.has(id))
      .map(async (id) => {
        try {
          const t = await apiFetch(`/api/tasks/${encodeURIComponent(id)}`);
          S.tasks.set(id, { title: String(t.title ?? '').slice(0, 120), project: t.project?.name ?? t.project?.slug ?? '' });
        } catch {
          /* the card just has no task line */
        }
      }),
  );
}

async function onEvent(name, args) {
  const p = args[0] ?? {};
  if (name === 'ext:command') {
    // an agent's command for the browser (browser control): do it, answer with the result
    const r = await handleCommand(p);
    S.client?.emit('ext:result', { id: p.id, ...r });
    return;
  }
  if (name === 'approval:created' && p.approval) {
    S.approvals.set(p.approval.id, p.approval);
    await learnTasks();
    await render({ announce: true });
  } else if (name === 'approval:resolved') {
    await remove(p.approvalId ?? p.approval?.id);
  } else if (name === 'question:created' && p.question) {
    S.questions.set(p.question.id, p.question);
    await learnTasks();
    await render({ announce: true });
  } else if (name === 'question:resolved') {
    await remove(p.question?.id);
  } else if (name === 'task:deleted') {
    for (const [id, a] of S.approvals) if (a.taskId === p.taskId) S.approvals.delete(id);
    for (const [id, q] of S.questions) if (q.taskId === p.taskId) S.questions.delete(id);
    S.tasks.delete(p.taskId);
    await render({ announce: false });
  }
}

async function remove(id) {
  if (!id) return;
  S.approvals.delete(id);
  S.questions.delete(id);
  void chrome.notifications.clear(`req:${id}`);
  await render({ announce: false });
}

// ---- showing it ---------------------------------------------------------------------------------------------------------------------------
function cards() {
  return orderItems([...S.approvals.values()], [...S.questions.values()]).map((it) => buildCard(it, S.tasks.get(it.data.taskId)));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

/** Can a card be drawn on this tab: a web page, not the dashboard itself (which shows its own cards), and the person allowed it. */
async function drawable(tab) {
  if (!tab?.id || !injectable(tab.url)) return false;
  const cfg = await getConfig();
  if (cfg.origins.some((o) => tab.url === o || tab.url.startsWith(`${o}/`))) return false;
  return chrome.permissions.contains({ origins: [tab.url] }).catch(() => false);
}

const tell = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg).catch(() => null);

async function ensureInjected(tabId) {
  if (await tell(tabId, { type: 'overlay-ping' })) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
    return true;
  } catch {
    return false;
  }
}

/** Put the cards on the active tab (and take them off the one they were on). Returns whether a card is on screen. */
async function syncOverlay() {
  const list = cards();
  const tab = await activeTab();
  if (S.overlayTab && S.overlayTab !== tab?.id) {
    await tell(S.overlayTab, { type: 'overlay-hide' });
    S.overlayTab = null;
  }
  if (!tab || !(await drawable(tab))) return false;
  if (!list.length || Date.now() < S.snoozeUntil) {
    if (S.overlayTab === tab.id) await tell(tab.id, { type: 'overlay-hide' });
    S.overlayTab = null;
    return false;
  }
  if (!(await ensureInjected(tab.id))) return false;
  await tell(tab.id, { type: 'overlay-render', cards: list });
  S.overlayTab = tab.id;
  return true;
}

/** How many tabs of this server's dashboard are open (any window): the dashboard plays its own sound, so the extension stays quiet then. */
async function dashboardTabs() {
  const cfg = await getConfig();
  try {
    return (await chrome.tabs.query({ url: cfg.origins.map((o) => `${o}/*`) })).length;
  } catch {
    return 0;
  }
}

async function playSound({ force = false } = {}) {
  const p = await getPrefs();
  if (!force && !shouldPlaySound(p, await dashboardTabs())) return;
  try {
    const has = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!has.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Play a short sound when an agent waits for an answer' });
    await chrome.runtime.sendMessage({ type: 'play-sound', sound: p.soundName, volume: p.volume });
  } catch (e) {
    console.warn('sound failed', e);
  }
}

async function render({ announce }) {
  const list = cards();
  const count = list.length;
  const conn = await getConnection();
  void chrome.action.setBadgeText({ text: conn?.needsReconnect ? '!' : count ? String(count) : '' });
  void chrome.action.setBadgeBackgroundColor({ color: conn?.needsReconnect ? '#d33' : '#e08a00' });
  const shown = await syncOverlay();
  const fresh = list.filter((c) => !S.seen.has(c.id));
  for (const c of fresh) S.seen.add(c.id);
  if (announce && fresh.length) {
    void playSound();
    // no card on screen (a browser page, no permission, snoozed): a notification instead — the approvals that may be decided here get its buttons
    if (!shown) {
      for (const c of fresh) {
        const t = notificationText(c);
        void chrome.notifications.create(`req:${c.id}`, { type: 'basic', iconUrl: 'icons/128.png', title: t.title, message: t.message.slice(0, 300) || ' ', requireInteraction: true, buttons: c.kind === 'approval' && !c.needsDashboard ? [{ title: 'Approve' }, { title: 'Deny' }] : [] });
      }
    }
  }
  if (shown) for (const c of list) void chrome.notifications.clear(`req:${c.id}`);
  persist();
}

// ---- presence: is the person in front of this browser? (the server waits 10 s for an answer here before it bothers Telegram) ---------------
async function reportPresence(force = false) {
  let front = false;
  try {
    const w = await chrome.windows.getLastFocused();
    front = Boolean(w?.focused) && (await chrome.idle.queryState(60)) === 'active';
  } catch {
    /* unknown: treat as away */
  }
  if (!force && front === S.front) return;
  S.front = front;
  S.client?.emit(front ? 'client:focus' : 'client:blur');
}

// ---- answers from a card or a notification -------------------------------------------------------------------------------------------
async function send(path, body, id) {
  try {
    await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) await remove(id); // answered elsewhere meanwhile
    throw e;
  }
  await remove(id);
  return { ok: true };
}

/** The person pressed Stop: tell the server (it cuts the task off) and take the frames down. */
export async function emitStop() {
  await stopAgent();
  S.client?.emit('ext:stop');
}

export const inboxHandlers = {
  'agent-stop': async () => {
    await emitStop();
    return { ok: true };
  },
  'agent-allow': async () => {
    allowAgent();
    S.client?.emit('ext:allow');
    return { ok: true };
  },
  decide: (msg) => send(`/api/approvals/${encodeURIComponent(msg.id)}/decision`, { decision: msg.decision === 'approve' ? 'approve' : 'deny' }, msg.id),
  answer: (msg) => send(`/api/questions/${encodeURIComponent(msg.id)}/answer`, msg.body ?? {}, msg.id),
  'overlay-snooze': async () => {
    S.snoozeUntil = Date.now() + 2 * 60_000;
    await render({ announce: false });
    return { ok: true };
  },
  'inbox-status': async () => {
    await load();
    return { count: S.approvals.size + S.questions.size, allPages: await chrome.permissions.contains(ALL_PAGES), prefs: await getPrefs() };
  },
  'prefs-set': async (msg) => {
    const next = { ...(await getPrefs()), ...(msg.prefs ?? {}) };
    next.volume = Math.min(1, Math.max(0, Number(next.volume)));
    await chrome.storage.local.set({ prefs: next });
    return { ok: true, prefs: next };
  },
  'sound-test': async () => {
    await playSound({ force: true });
    return { ok: true };
  },
};

export function startInbox() {
  // every listener is registered here, synchronously, at the start of the service worker (a listener added later would miss the event that woke it)
  chrome.tabs.onActivated.addListener(() => void load().then(() => render({ announce: false })));
  chrome.tabs.onUpdated.addListener((id, change, tab) => {
    if (change.status === 'complete' && tab.active) void load().then(() => render({ announce: false }));
  });
  chrome.windows.onFocusChanged.addListener(() => {
    void reportPresence();
    void load().then(() => render({ announce: false }));
  });
  chrome.idle.setDetectionInterval(60);
  chrome.idle.onStateChanged.addListener(() => void reportPresence());
  chrome.notifications.onButtonClicked.addListener(async (nid, i) => {
    await load(); // a click may wake a worker that lost its memory
    const id = nid.replace(/^req:/, '');
    if (S.approvals.has(id)) void inboxHandlers.decide({ id, decision: i === 0 ? 'approve' : 'deny' }).catch(() => undefined);
  });
  chrome.notifications.onClicked.addListener(async (nid) => {
    await load();
    const id = nid.replace(/^req:/, '');
    const x = S.approvals.get(id) ?? S.questions.get(id);
    const conn = await getConnection();
    if (conn && x) await chrome.tabs.create({ url: `${conn.origin}/tasks/${x.taskId}` });
    void chrome.notifications.clear(nid);
  });
  chrome.alarms.create('inbox', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'inbox') {
      void ensure();
      void reportPresence();
    }
  });
  watchTabs();
  // a change of what the browser lets the extension do is told to the server at once (its Add-ons page shows who has no access to sites)
  const permissionsChanged = () => {
    void render({ announce: false });
    void apiFetch('/api/extension/me').catch(() => undefined);
  };
  chrome.permissions.onAdded.addListener(permissionsChanged);
  chrome.permissions.onRemoved.addListener(permissionsChanged);
  void ensure();
}
