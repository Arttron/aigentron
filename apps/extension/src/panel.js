import { ApiError, apiFetch } from './lib/api.js';
import { agentsFor, pickProject } from './lib/compose-core.js';
import { render as markdown } from './lib/md.js';
import { micButton } from './lib/mic.js';
import { SioClient, socketUrl } from './lib/sio.js';
import { getConfig, getConnection } from './lib/store.js';
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
}

function addMessage(m) {
  const box = document.getElementById('conv');
  if (!box || box.querySelector(`[data-key="${CSS.escape(m.id)}"]`)) return;
  const node = el('div', { className: `msg ${m.role}` });
  node.dataset.key = m.id;
  if (m.role !== 'you') node.append(el('div', { className: 'who', textContent: m.speaker ?? (m.role === 'result' ? 'answer' : 'agent') }));
  node.append(markdown(m.text));
  const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
  box.append(node);
  if (atBottom) main.scrollTop = main.scrollHeight;
}

function addLive(p) {
  const msgs = toMessages([{ ...p, id: `live:${p.kind}:${p.seq}` }]);
  for (const m of msgs) addMessage(m);
}

async function openConversation(id, known) {
  S.tab = 'conv';
  S.conv = { id, status: known?.status ?? '' };
  S.client?.emit('subscribe:task', id);
  await guard(async () => {
    const [task, events] = await Promise.all([apiFetch(`/api/tasks/${encodeURIComponent(id)}`), apiFetch(`/api/tasks/${encodeURIComponent(id)}/transcript`)]);
    S.conv.status = task.status;
    const conn = await getConnection();
    const input = el('textarea', { rows: 3, placeholder: 'Write to the agent…' });
    const sendBtn = el('button', { className: 'primary', textContent: 'Send' });
    const err = el('div', { className: 'bad' });
    const post = async () => {
      const text = input.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      err.textContent = '';
      try {
        await apiFetch(`/api/tasks/${encodeURIComponent(id)}/follow-up`, { method: 'POST', body: JSON.stringify({ prompt: text }) });
        input.value = '';
        // the server writes the message into the transcript; show it from there (live events may bring it too — duplicates are ignored)
        const fresh = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/transcript`);
        for (const m of toMessages(fresh)) addMessage(m);
      } catch (e) {
        err.textContent = e.message;
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
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post(); });
    main.replaceChildren(
      el('div', { className: 'row' }, el('button', { textContent: '‹ Back', onclick: () => setTab('tasks') }), el('span', { id: 'convStatus' }), el('span', { className: 'spacer' }), el('button', { textContent: 'Open in dashboard', onclick: () => send({ type: 'open', path: `/tasks/${id}` }) })),
      el('div', { className: 'muted', textContent: task.title ?? '' }),
      el('div', { className: 'conv', id: 'conv' }),
      el('div', { className: 'composer' }, input, el('div', { className: 'row' }, sendBtn, shotBtn, el('span', { id: 'micSlot' }), el('span', { className: 'muted', textContent: 'Ctrl/⌘ + Enter sends' })), err),
    );
    void micButton(input, { onNeedPermission: () => void send({ type: 'open-mic' }) }).then((m) => m && document.getElementById('micSlot')?.replaceWith(m));
    paintStatus();
    for (const m of toMessages(events)) addMessage(m);
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
