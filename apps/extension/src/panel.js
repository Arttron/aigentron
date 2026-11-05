import { ApiError, apiFetch } from './lib/api.js';
import { agentsFor, pickProject } from './lib/compose-core.js';
import { render as markdown } from './lib/md.js';
import { micButton } from './lib/mic.js';
import { SioClient, socketUrl } from './lib/sio.js';
import { getConfig, getConnection } from './lib/store.js';
import { newPending, reconcilePending, waiting } from './lib/chat-state.js';
import { applyFormat, continueList, diffRange, insertQuote, pasteLinkOverSelection, shortcutAction } from './lib/md-edit.js';
import { quoteText } from './lib/quote.js';
import { ago, sortTasks, statusChip, toMessages } from './lib/transcript.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const main = $('main');

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
}

const S = { tab: 'tasks', conv: null, filter: 'attention', project: '', projects: [], agents: [], client: null, listTimer: null, memory: { site: {}, last: '' } };

// ---- the live connection (the panel's own: it hears task changes and the open conversation) ------------------------------------------------
async function connect() {
  const conn = await getConnection();
  if (!conn || conn.needsReconnect) return;
  S.client = new SioClient({
    url: socketUrl(conn.origin),
    auth: { token: conn.token },
    onState: (state) => {
      $('conn').textContent = state === 'open' ? '● live' : state === 'connecting' ? '… connecting' : '○ offline';
      if (state === 'open' && S.conv) S.client.emit('subscribe:task', S.conv.id);
    },
    onEvent: (name, args) => {
      const p = args[0] ?? {};
      if (name === 'agent:log' && S.conv && p.taskId === S.conv.id) addLive(p);
      else if (name === 'task:followup-queue' && S.conv && p.taskId === S.conv.id) {
        S.conv.queue = Array.isArray(p.queue) ? p.queue : [];
        paintTail();
      }
      else if (name === 'task:status' && S.conv && p.taskId === S.conv.id) {
        S.conv.status = p.status;
        paintStatus();
      } else if ((name === 'task:upserted' || name === 'task:status' || name === 'task:deleted') && S.tab === 'tasks' && !S.conv) {
        clearTimeout(S.listTimer);
        S.listTimer = setTimeout(() => void showTasks(), 600);
      }
    },
  });
  S.client.start();
}

// ---- tabs --------------------------------------------------------------------------------------------------------------------------------------
function setTab(tab) {
  S.tab = tab;
  leaveConversation();
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
  stopBugPoll();
  void (tab === 'tasks' ? showTasks() : tab === 'chat' ? showChat() : showBug());
}
for (const b of $('tabs').children) b.addEventListener('click', () => setTab(b.dataset.tab));

const guard = (fn) => fn().catch((e) => main.replaceChildren(el('p', { className: 'bad', textContent: e instanceof ApiError ? e.message : String(e.message ?? e) })));

// ---- the task list -------------------------------------------------------------------------------------------------------------------------
async function showTasks() {
  await guard(async () => {
    const q = new URLSearchParams({ pageSize: '30' });
    if (S.filter !== 'all') q.set('status', S.filter);
    if (S.project) q.set('project', S.project);
    const page = await apiFetch(`/api/tasks?${q}`);
    const items = sortTasks(Array.isArray(page) ? page : page.items ?? []);

    const chips = el('div', { className: 'row chips' });
    for (const [id, label] of [['attention', 'Needs me'], ['active', 'Running'], ['all', 'All']]) {
      chips.append(el('button', { textContent: label, className: S.filter === id ? 'on' : '', onclick: () => { S.filter = id; void showTasks(); } }));
    }
    const proj = el('select', { onchange: () => { S.project = proj.value; void showTasks(); } }, el('option', { value: '', textContent: 'All projects' }), ...S.projects.map((p) => el('option', { value: p.slug, textContent: p.name })));
    proj.value = S.project;
    const list = items.length
      ? items.map((t) => {
          const chip = statusChip(t.status);
          return el(
            'div',
            { className: 'task', onclick: () => void openConversation(t.id, t) },
            el('div', { className: 't', textContent: t.title || t.prompt?.slice(0, 80) || 'Task' }),
            el('div', { className: 'row' }, el('span', { className: `chip ${chip.tone}`, textContent: chip.label }), el('span', { className: 'muted', textContent: [t.agentName, ago(t.updatedAt)].filter(Boolean).join(' · ') })),
          );
        })
      : [el('p', { className: 'muted', textContent: S.filter === 'attention' ? 'Nothing needs you right now.' : 'No tasks here.' })];
    main.replaceChildren(el('div', { className: 'row' }, proj), chips, ...list);
  });
}

// ---- a conversation ------------------------------------------------------------------------------------------------------------------------
function leaveConversation() {
  if (S.conv) S.client?.emit('unsubscribe:task', S.conv.id);
  S.conv = null;
}

function paintStatus() {
  const chip = statusChip(S.conv?.status);
  const slot = document.getElementById('convStatus');
  if (slot) slot.replaceChildren(el('span', { className: `chip ${chip.tone}`, textContent: chip.label }));
  paintTail(); // what waits depends on whether the task is waiting to start
}

/** Where a quote goes: the message box of the open conversation. */
function quoteInto(text) {
  const input = document.getElementById('convInput');
  const quote = quoteText(text);
  if (!input || !quote) return;
  const at = document.activeElement === input ? { text: input.value, start: input.selectionStart, end: input.selectionEnd } : { text: input.value, start: input.value.length, end: input.value.length };
  commitEdit(input, insertQuote(at, quote));
  input.focus();
  input.scrollTop = input.scrollHeight;
}

/** A change to the box made with the browser's own editing command (Ctrl+Z undoes it); falls back to setting the value. */
function commitEdit(input, next) {
  input.focus();
  const d = diffRange(input.value, next.text);
  let done = false;
  try {
    input.setSelectionRange(d.from, d.to);
    done = d.insert ? document.execCommand('insertText', false, d.insert) : d.from === d.to ? true : document.execCommand('delete');
  } catch {
    done = false;
  }
  if (!(done && input.value === next.text)) {
    input.value = next.text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.setSelectionRange(next.start, next.end);
}

function addMessage(m, { live = false, settle = false } = {}) {
  const box = document.getElementById('conv');
  if (!box || box.querySelector(`[data-key="${CSS.escape(m.id)}"]`) || (m.ck && box.querySelector(`[data-ck="${CSS.escape(m.ck)}"]`))) return false;
  const node = el('div', { className: `msg ${m.role}` });
  node.dataset.key = m.id;
  if (m.ck) node.dataset.ck = m.ck;
  if (m.role !== 'you') node.append(el('div', { className: 'who', textContent: m.speaker ?? (m.role === 'result' ? 'answer' : 'agent') }));
  node.append(markdown(m.text));
  node.append(el('button', { type: 'button', className: 'qbtn', textContent: '❝', title: 'Quote this message', 'aria-label': 'Quote this message', onclick: () => quoteInto(m.text) }));
  const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
  box.append(node);
  // a message of the person's own that arrives while the panel is open settles its "sending…" / "starting" copy
  if ((live || settle) && m.role === 'you' && S.conv) {
    S.conv.echoed.push(m.text);
    S.conv.echoed = S.conv.echoed.slice(-30);
    S.conv.pending = reconcilePending(S.conv.pending, S.conv.echoed);
    paintTail();
  }
  if (atBottom) main.scrollTop = main.scrollHeight;
  return true;
}

function addLive(p) {
  const msgs = toMessages([{ ...p, id: `live:${p.kind}:${p.seq}` }]);
  for (const m of msgs) addMessage(m, { live: true });
}

/** What waits under the conversation: messages in the server's queue (with ✎ / ✕), the one whose run is starting, and the one being sent right now. */
function paintTail() {
  const tail = document.getElementById('convTail');
  const c = S.conv;
  if (!tail || !c) return;
  const items = waiting({ queue: c.queue, pending: c.pending, status: c.status, echoedTexts: c.echoed.slice(-5) });
  const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
  tail.replaceChildren(
    ...items.map((i) => {
      const note = i.kind === 'queued' ? 'queued — sent when the run ends' : i.kind === 'starting' ? 'starting — waiting for the server' : 'sending…';
      const node = el('div', { className: 'msg you waiting' }, markdown(i.text), el('div', { className: 'note' }, el('span', { textContent: note })));
      if (i.kind === 'queued') {
        const row = node.querySelector('.note');
        row.append(
          el('button', { type: 'button', className: 'qact', textContent: '✎', title: 'Edit: take it back into the message box', onclick: () => void editQueued(i) }),
          el('button', { type: 'button', className: 'qact', textContent: '✕', title: 'Remove from the queue', onclick: () => void removeQueued(i) }),
        );
      }
      return node;
    }),
  );
  if (items.length && atBottom) main.scrollTop = main.scrollHeight;
}

async function refreshQueue() {
  const c = S.conv;
  if (!c) return;
  const q = await apiFetch(`/api/tasks/${encodeURIComponent(c.id)}/pending-follow-ups`).catch(() => null);
  if (Array.isArray(q) && S.conv === c) {
    c.queue = q;
    paintTail();
  }
}

async function removeQueued(item) {
  const c = S.conv;
  if (!c) return null;
  const q = await apiFetch(`/api/tasks/${encodeURIComponent(c.id)}/pending-follow-ups/${encodeURIComponent(item.id)}`, { method: 'DELETE' }).catch(() => null);
  if (Array.isArray(q) && S.conv === c) {
    c.queue = q;
    paintTail();
  }
  return Array.isArray(q) ? q : null;
}

/** Edit a queued message: it leaves the queue and its text comes back into the box, ahead of what is typed there. */
async function editQueued(item) {
  const left = await removeQueued(item);
  // only when it is really out of the queue: if the removal failed, or the run has already taken it, its text must not ALSO come back into the box (it would be sent twice)
  if (!left || left.some((q) => q.id === item.id)) return;
  const input = document.getElementById('convInput');
  if (input) {
    commitEdit(input, { text: item.text + (input.value ? `\n\n${input.value}` : ''), start: item.text.length, end: item.text.length });
    input.focus();
  }
}

/** A part of a message selected with the mouse or the finger: a "Quote" button over the selection puts exactly that text into the box. */
let selectionPop = null;
function watchSelection() {
  const hide = () => {
    selectionPop?.remove();
    selectionPop = null;
  };
  const check = () => {
    const sel = window.getSelection();
    const box = document.getElementById('conv');
    if (!sel || sel.isCollapsed || !sel.rangeCount || !box) return hide();
    const range = sel.getRangeAt(0);
    const a = range.commonAncestorContainer;
    const node = a.nodeType === 1 ? a : a.parentElement;
    if (!node || !box.contains(node) || node.closest('textarea, input, button')) return hide();
    const text = sel.toString().trim();
    const r = range.getBoundingClientRect();
    if (!text || (!r.width && !r.height)) return hide();
    hide();
    selectionPop = el('button', { type: 'button', className: 'quote-pop', textContent: '❝ Quote' });
    selectionPop.style.left = `${Math.min(Math.max(r.left + r.width / 2, 50), window.innerWidth - 50)}px`;
    selectionPop.style.top = `${r.top < 40 ? r.bottom + 6 : r.top - 36}px`;
    selectionPop.onmousedown = (e) => e.preventDefault(); // the selection must survive the press
    selectionPop.onclick = () => {
      quoteInto(text);
      window.getSelection()?.removeAllRanges();
      hide();
    };
    document.body.append(selectionPop);
  };
  let timer;
  document.addEventListener('selectionchange', () => {
    clearTimeout(timer);
    timer = setTimeout(check, 180);
  });
  document.addEventListener('mouseup', () => setTimeout(check, 0));
  main.addEventListener('scroll', hide, { passive: true });
}
watchSelection();

async function openConversation(id, known) {
  S.tab = 'conv';
  S.conv = { id, status: known?.status ?? '', queue: [], pending: [], echoed: [] };
  S.client?.emit('subscribe:task', id);
  await guard(async () => {
    const [task, events] = await Promise.all([apiFetch(`/api/tasks/${encodeURIComponent(id)}`), apiFetch(`/api/tasks/${encodeURIComponent(id)}/transcript`)]);
    S.conv.status = task.status;
    const conn = await getConnection();
    const input = el('textarea', { rows: 3, id: 'convInput', placeholder: 'Write to the agent…  (Enter sends, Shift+Enter adds a line; ⌘/Ctrl+B bold, I italic, K link)' });
    const sendBtn = el('button', { className: 'primary', textContent: 'Send' });
    const err = el('div', { className: 'bad' });
    const post = async () => {
      const text = input.value.trim();
      if (!text || sendBtn.disabled) return; // (Enter while the last message is still going out)
      const conv = S.conv;
      // the message is shown AT ONCE ("sending…"): a task that is busy puts it in the queue, and the transcript has it only when its run starts
      const mine = newPending(text);
      conv.pending.push(mine);
      input.value = '';
      err.textContent = '';
      sendBtn.disabled = true;
      paintTail();
      main.scrollTop = main.scrollHeight;
      try {
        await apiFetch(`/api/tasks/${encodeURIComponent(id)}/follow-up`, { method: 'POST', body: JSON.stringify({ prompt: text }) });
        if (S.conv !== conv) return; // the person went to another conversation meanwhile: this one's rows must not be written into that one
        await refreshQueue();
        if (S.conv !== conv) return;
        // the server writes the message into the transcript when the run starts; live events bring it too — duplicates are ignored
        const fresh = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/transcript`).catch(() => []);
        if (S.conv !== conv) return;
        for (const m of toMessages(fresh)) addMessage(m, { settle: true });
        // the server has it now: it is in the queue, starting, or in the conversation — shown from there. The local "sending…" copy has done its job
        // (kept, it would come back as "sending…" if the person took the message out of the queue)
        conv.pending = conv.pending.filter((x) => x.id !== mine.id);
        paintTail();
      } catch (e) {
        conv.pending = conv.pending.filter((x) => x.id !== mine.id); // it was not sent after all: the text comes back
        if (S.conv === conv) {
          commitEdit(input, { text: text + (input.value ? `\n\n${input.value}` : ''), start: text.length, end: text.length });
          err.textContent = e.message;
          paintTail();
        }
      } finally {
        sendBtn.disabled = false;
      }
    };
    sendBtn.onclick = post;
    // a screenshot of the page the person is on goes into THIS task: the edit page opens with the task already chosen
    const shotBtn = el('button', { textContent: '📷 Screenshot', title: 'Take a screenshot of the page you are on, mark it, and send it to this task' });
    shotBtn.onclick = async () => {
      err.textContent = '';
      const r = await send({ type: 'compose-start', kind: 'screenshot', task: id }).catch((e) => ({ ok: false, error: e.message }));
      if (!r?.ok) err.textContent = r?.error || 'Could not capture this page — open a web page first.';
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      const action = shortcutAction(e);
      if (action) {
        e.preventDefault();
        commitEdit(input, applyFormat({ text: input.value, start: input.selectionStart, end: input.selectionEnd }, action));
        return;
      }
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        const next = continueList({ text: input.value, start: input.selectionStart, end: input.selectionEnd });
        if (next) {
          e.preventDefault();
          commitEdit(input, next);
        }
        return;
      }
      // Enter sends (as in the dashboard); Shift+Enter is a new line
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void post();
      }
    });
    input.addEventListener('paste', (e) => {
      const next = pasteLinkOverSelection({ text: input.value, start: input.selectionStart, end: input.selectionEnd }, e.clipboardData?.getData('text/plain') ?? '');
      if (next) {
        e.preventDefault();
        commitEdit(input, next);
      }
    });
    main.replaceChildren(
      el('div', { className: 'row' }, el('button', { textContent: '‹ Back', onclick: () => setTab('tasks') }), el('span', { id: 'convStatus' }), el('span', { className: 'spacer' }), el('button', { textContent: 'Open in dashboard', onclick: () => send({ type: 'open', path: `/tasks/${id}` }) })),
      el('div', { className: 'muted', textContent: task.title ?? '' }),
      el('div', { className: 'conv', id: 'conv' }),
      el('div', { className: 'conv', id: 'convTail' }),
      el('div', { className: 'composer' }, input, el('div', { className: 'row' }, sendBtn, shotBtn, el('span', { id: 'micSlot' }), el('span', { className: 'muted', textContent: 'Enter sends · Shift+Enter new line' })), err),
    );
    void micButton(input, { onNeedPermission: () => void send({ type: 'open-mic' }) }).then((m) => m && document.getElementById('micSlot')?.replaceWith(m));
    for (const m of toMessages(events)) addMessage(m);
    paintStatus();
    await refreshQueue(); // messages that wait for the run to end are listed (and kept up to date by the live queue event)
    main.scrollTop = main.scrollHeight;
    void conn;
  });
}

// ---- a new chat ----------------------------------------------------------------------------------------------------------------------------
async function showChat() {
  await guard(async () => {
    const conn = await getConnection();
    if (!conn) throw new Error('Not connected — open the Aigentron dashboard and press Connect.');
    const project = el('select');
    project.append(...S.projects.map((p) => el('option', { value: p.slug, textContent: p.name })));
    project.value = pickProject(S.projects, S.memory, '') || S.projects[0]?.slug || '';
    const agent = el('select');
    const fillAgents = () => {
      const p = S.projects.find((x) => x.slug === project.value);
      agent.replaceChildren(el('option', { value: '', textContent: p?.defaultAgent ? `project default (${p.defaultAgent})` : 'default agent' }), ...agentsFor(p, S.agents).list.map((a) => el('option', { value: a.name, textContent: a.name })));
    };
    project.onchange = fillAgents;
    fillAgents();
    const input = el('textarea', { rows: 5, placeholder: 'Ask an agent, or describe the job…' });
    const withPage = el('input', { type: 'checkbox' });
    const err = el('div', { className: 'bad' });
    const go = el('button', { className: 'primary', textContent: 'Send' });
    go.onclick = async () => {
      const prompt = input.value.trim();
      if (!prompt) return;
      go.disabled = true;
      err.textContent = '';
      try {
        let page;
        if (withPage.checked) {
          const cap = await send({ type: 'capture-active' });
          if (!cap?.ok) throw new Error(cap?.error ?? 'Could not read this page');
          page = { url: cap.url, title: cap.title, text: cap.text, ...(cap.selection ? { selection: cap.selection } : {}) };
        }
        const r = await apiFetch('/api/extension/clip', { method: 'POST', body: JSON.stringify({ mode: 'task', project: project.value, agentName: agent.value || undefined, prompt, ...(page ? { page } : {}) }) });
        await openConversation(r.id);
      } catch (e) {
        err.textContent = e.message;
        go.disabled = false;
      }
    };
    main.replaceChildren(
      el('div', { className: 'row' }, project, agent),
      input,
      el('label', { className: 'chk' }, withPage, document.createTextNode('Include the text of the page I am on (click the extension icon on that page first)')),
      el('div', { className: 'row' }, go, el('span', { id: 'micSlot2' })),
      err,
    );
    void micButton(input, { onNeedPermission: () => void send({ type: 'open-mic' }) }).then((m) => m && document.getElementById('micSlot2')?.replaceWith(m));
    input.focus();
  });
}

// ---- report a bug ----------------------------------------------------------------------------------------------------------------------------
const bugState = { tabId: null, element: null, timer: null };
function stopBugPoll() {
  clearInterval(bugState.timer);
  bugState.timer = null;
}

async function showBug() {
  const running = bugState.tabId !== null;
  const err = el('div', { className: 'bad' });
  const fail = (r) => { err.textContent = r?.error ?? 'Something went wrong'; };
  if (!running) {
    main.replaceChildren(
      el('p', { textContent: 'Record what goes wrong on a page and send it to an agent: console errors, failed requests, the element you point at, a screenshot.' }),
      el('p', { className: 'muted', textContent: 'Open the page with the problem, then start recording. Recording works on that tab only, until it is reloaded.' }),
      el('button', { className: 'primary', textContent: 'Start recording on this page', onclick: async () => { const r = await send({ type: 'bug-start' }); if (!r?.ok) return fail(r); bugState.tabId = r.tabId; bugState.element = null; void showBug(); } }),
      err,
    );
    return;
  }
  const counts = el('p', { className: 'muted', textContent: 'Recording…' });
  const picked = el('p', { className: 'muted', textContent: bugState.element ? `Element: ${bugState.element.selector}` : 'No element picked (optional).' });
  const poll = async () => {
    const r = await send({ type: 'bug-peek', tabId: bugState.tabId });
    counts.textContent = r?.ok ? (r.recording ? `Recording — ${r.errors} errors, ${r.console} console, ${r.network} failed requests so far` : 'The page was reloaded: recording stopped. Start again.') : (r?.error ?? '');
  };
  main.replaceChildren(
    el('p', { textContent: 'Now do what causes the problem on that page.' }),
    counts,
    picked,
    el('div', { className: 'row' },
      el('button', { textContent: 'Pick the element', onclick: async () => { const r = await send({ type: 'bug-pick', tabId: bugState.tabId }); if (!r?.ok) return fail(r); if (r.element) { bugState.element = r.element; picked.textContent = `Element: ${r.element.selector}`; } } }),
      el('button', { className: 'primary', textContent: 'Finish and review', onclick: async () => { const r = await send({ type: 'bug-finish', tabId: bugState.tabId, element: bugState.element }); if (!r?.ok) return fail(r); bugState.tabId = null; stopBugPoll(); void showBug(); } }),
      el('button', { textContent: 'Cancel', onclick: () => { bugState.tabId = null; stopBugPoll(); void showBug(); } }),
    ),
    err,
  );
  await poll();
  bugState.timer = setInterval(() => void poll(), 2000);
}

// ---- start ---------------------------------------------------------------------------------------------------------------------------------------
(async () => {
  const cfg = await getConfig();
  $('server').textContent = cfg.serverName ?? '';
  const conn = await getConnection();
  if (!conn || conn.needsReconnect) {
    main.replaceChildren(el('p', { className: conn?.needsReconnect ? 'bad' : 'muted', textContent: conn?.needsReconnect ? 'The extension was signed out of the server.' : 'Not connected yet.' }), el('p', { className: 'muted', textContent: 'Open the Aigentron dashboard and press Connect (Add-ons → Extension).' }), el('button', { className: 'primary', textContent: 'Open the dashboard', onclick: () => send({ type: 'open', path: '/addons?tab=extension' }) }));
    return;
  }
  try {
    const [projects, agents, mem] = await Promise.all([apiFetch('/api/projects'), apiFetch('/api/agents'), send({ type: 'memory-get' })]);
    S.projects = projects.filter((p) => !p.archivedAt);
    S.agents = agents;
    S.memory = mem?.memory ?? S.memory;
  } catch (e) {
    main.replaceChildren(el('p', { className: 'bad', textContent: e.message }));
    return;
  }
  void send({ type: 'status' }).then((st) => {
    if (st?.update) $('conn').after(el('button', { textContent: `Update ${st.update.available}`, title: 'A newer version of the extension is available', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('update.html') }) }));
  });
  void connect();
  void showTasks();
})();
