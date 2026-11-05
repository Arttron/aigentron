import { agentsFor, buildClip, filterTasks, fitSize, normRect, pickProject, siteKey, statusLabel } from './lib/compose-core.js';
import { micButton } from './lib/mic.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const params = new URLSearchParams(location.search);

const state = { draft: null, tasks: [], taskId: '', taskFilter: '', projects: [], agents: [], kbs: [], mode: 'task', project: '', agentName: '', kb: '', prompt: '', includeText: false, includeSelection: false, includeShot: false, includeBug: false, screenshot: null, marks: [] };
let image = null; // the screenshot as an <img>
let memory = { site: {}, last: '' };

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
}
const fill = (select, items, value) => {
  select.replaceChildren(...items.map((i) => el('option', { value: i.value, textContent: i.label })));
  if (value !== undefined && items.some((i) => i.value === value)) select.value = value;
};
const status = (text, cls = 'muted') => Object.assign($('status'), { textContent: text, className: cls });

// ---- the draft (what was captured when the person pressed the button) -------------------------------------------------------------
async function loadDraft() {
  let id = params.get('draft');
  if (!id && params.get('find')) {
    // a deep link: capture the tab whose address matches (used where there is no toolbar click — and by the end-to-end test)
    const r = await send({ type: 'compose-start', kind: params.get('kind') || 'page', find: params.get('find'), open: false });
    if (!r?.id) throw new Error(r?.error || 'Could not capture that tab');
    id = r.id;
  }
  if (!id) throw new Error('Nothing to send: use the toolbar button, the right-click menu or Alt+Shift+A on a page.');
  const got = await chrome.storage.session.get(`draft:${id}`);
  const d = got[`draft:${id}`];
  if (!d) throw new Error('This draft is gone (the browser was restarted?). Capture the page again.');
  return d;
}

function renderSource() {
  const d = state.draft;
  const box = $('source');
  box.replaceChildren(el('div', { className: 'title', textContent: d.title || '(no title)' }), el('a', { href: d.url, textContent: d.url, target: '_blank', rel: 'noreferrer' }));
  if (d.note) box.append(el('div', { className: 'muted', textContent: d.note }));
  if (d.linkUrl) box.append(el('div', { className: 'muted', textContent: `Link: ${d.linkUrl}` }));
  if (d.selection) box.append(el('div', { className: 'muted', textContent: `Selected text (${d.selection.length} characters):` }), el('pre', { className: 'excerpt', textContent: d.selection.slice(0, 1500) }));

  const inc = $('includes');
  inc.replaceChildren();
  const add = (key, label, on, enabled) => {
    const cb = el('input', { type: 'checkbox', checked: on, disabled: !enabled });
    cb.addEventListener('change', () => { state[key] = cb.checked; refresh(); });
    inc.append(el('label', {}, cb, document.createTextNode(label)));
  };
  add('includeSelection', `the selection (${d.selection?.length ?? 0} characters)`, state.includeSelection, Boolean(d.selection));
  add('includeText', `the page text (${Math.round((d.text?.length ?? 0) / 1000)} KB)`, state.includeText, Boolean(d.text));
  add('includeShot', 'a screenshot', state.includeShot, Boolean(d.screenshot));
  if (d.bug) {
    const b = d.bug;
    add('includeBug', `the bug report data (${b.console.length} console, ${b.network.length} failed requests, ${b.errors.length} errors${b.element ? ', the element you picked' : ''})`, state.includeBug, true);
    box.append(el('pre', { className: 'excerpt', textContent: [b.element ? `element: ${b.element.selector}` : '', ...b.errors.slice(-3).map((e) => `error: ${e.message}`), ...b.console.slice(-3).map((c) => `console ${c.level}: ${c.text}`), ...b.network.slice(-4).map((n) => `${n.method} ${n.url} → ${n.status || 'failed'}`)].filter(Boolean).join('\n').slice(0, 900) }));
  }
}

// ---- the screenshot with marks -----------------------------------------------------------------------------------------------------
function drawCanvas() {
  const c = $('canvas');
  if (!image) return;
  const ctx = c.getContext('2d');
  ctx.drawImage(image, 0, 0, c.width, c.height);
  ctx.lineWidth = Math.max(3, Math.round(c.width / 220));
  ctx.strokeStyle = '#ff2d2d';
  for (const r of state.marks) ctx.strokeRect(r.x, r.y, r.w, r.h);
}

function setupCanvas() {
  const c = $('canvas');
  // the preview works at the size it is sent at: the longest side at most 1600 px
  const { w, h } = fitSize(image.naturalWidth, image.naturalHeight, 1600);
  c.width = w;
  c.height = h;
  let from = null;
  const pos = (e) => {
    const b = c.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * c.width, y: ((e.clientY - b.top) / b.height) * c.height };
  };
  c.addEventListener('pointerdown', (e) => {
    try {
      c.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer that cannot be captured (a synthetic one): the drag still works inside the canvas */
    }
    from = pos(e);
  });
  c.addEventListener('pointermove', (e) => {
    if (!from) return;
    const p = pos(e);
    const r = normRect(from.x, from.y, p.x, p.y, 1);
    drawCanvas();
    if (r) { const ctx = c.getContext('2d'); ctx.lineWidth = Math.max(3, Math.round(c.width / 220)); ctx.strokeStyle = '#ff2d2d'; ctx.strokeRect(r.x, r.y, r.w, r.h); }
  });
  c.addEventListener('pointerup', (e) => {
    if (!from) return;
    const p = pos(e);
    const r = normRect(from.x, from.y, p.x, p.y);
    from = null;
    if (r) state.marks.push(r);
    drawCanvas();
  });
  $('undo').onclick = () => { state.marks.pop(); drawCanvas(); };
  $('clear').onclick = () => { state.marks = []; drawCanvas(); };
  drawCanvas();
}

/** The picture as sent: the canvas (marks included) as a JPEG, without the data: prefix. */
function screenshotBase64() {
  const url = $('canvas').toDataURL('image/jpeg', 0.85);
  return url.slice(url.indexOf(',') + 1);
}

// ---- the form ----------------------------------------------------------------------------------------------------------------------
function refresh() {
  const mode = state.mode;
  const toTask = mode === 'task' || mode === 'followup';
  $('projectWrap').hidden = mode === 'followup'; // a task already has its project
  $('agentWrap').hidden = mode !== 'task';
  $('kbWrap').hidden = mode !== 'kb';
  $('taskWrap').hidden = mode !== 'followup';
  $('shotCard').hidden = !(toTask && state.includeShot && image);
  $('promptHint').textContent = mode === 'task' ? '(optional if you include something)' : mode === 'followup' ? '(optional if you include something — it goes into the chat of the task)' : '(the title of the note, optional)';
  $('prompt').placeholder = mode === 'followup' ? 'For example: this is how it looks now — the button is still cut off…' : 'For example: summarise it, check the claims, turn it into a task list…';
  const hasContent = toTask
    ? state.prompt.trim() || (state.includeText && state.draft.text) || (state.includeSelection && state.draft.selection) || state.includeShot || (state.includeBug && state.draft.bug)
    : (state.includeText && state.draft.text) || (state.includeSelection && state.draft.selection);
  $('send').disabled = !hasContent || (mode === 'followup' ? !state.taskId : !state.project) || (mode === 'kb' && !state.kb);
  $('send').textContent = mode === 'followup' ? 'Send to the task' : mode === 'kb' ? 'Save the note' : 'Create the task';
}

// ---- the task a message goes to ------------------------------------------------------------------------------------------------------------
function renderTasks() {
  const list = $('taskList');
  const shown = filterTasks(state.tasks, state.taskFilter);
  if (!shown.length) {
    list.replaceChildren(el('div', { className: 'muted emptyList', textContent: state.tasks.length ? 'No task matches.' : 'No tasks yet.' }));
    return;
  }
  list.replaceChildren(
    ...shown.map((t) => {
      const [label, tone] = statusLabel(t.status);
      const item = el('button', { type: 'button', className: 'taskItem', role: 'option', title: t.title }, el('span', { className: 't', textContent: t.title || '(untitled)' }), el('span', { className: `chip ${tone}`, textContent: label }), el('span', { className: 'm', textContent: t.projectSlug ?? '' }));
      item.setAttribute('aria-selected', String(t.id === state.taskId));
      item.onclick = () => { state.taskId = t.id; renderTasks(); refresh(); };
      return item;
    }),
  );
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

async function loadTasks() {
  if (state.tasksLoaded) return;
  state.tasksLoaded = true;
  const r = await send({ type: 'tasks', include: state.taskId || undefined });
  if (!r?.tasks) {
    $('taskList').replaceChildren(el('div', { className: 'bad emptyList', textContent: r?.error || 'Could not load the tasks.' }));
    state.tasksLoaded = false;
    return;
  }
  state.tasks = r.tasks;
  renderTasks();
}

async function loadKbs() {
  const r = await send({ type: 'kbs', project: state.project });
  state.kbs = r.kbs ?? [];
  fill($('kb'), state.kbs.length ? state.kbs.map((k) => ({ value: k.name, label: k.global ? `${k.name} (global)` : k.name })) : [{ value: '', label: '— this project has no knowledge base —' }], state.kb);
  state.kb = $('kb').value;
}

function projectChanged() {
  const p = state.projects.find((x) => x.slug === state.project);
  const { list } = agentsFor(p, state.agents);
  fill($('agent'), [{ value: '', label: p?.defaultAgent ? `project default (${p.defaultAgent})` : 'default agent' }, ...list.map((a) => ({ value: a.name, label: a.name }))], '');
  state.agentName = '';
  void loadKbs().then(refresh);
  refresh();
}

async function init() {
  const cfg = await send({ type: 'status' });
  $('server').textContent = cfg.serverName ?? '';
  if (!cfg.connected) throw new Error('The extension is not connected. Open the Aigentron dashboard and press Connect.');
  state.draft = await loadDraft();
  const d = state.draft;
  if (d.note) Object.assign($('notice'), { hidden: false, textContent: d.note });
  state.includeSelection = Boolean(d.selection);
  state.includeText = !d.selection && d.kind === 'page' && Boolean(d.text);
  state.includeShot = (d.kind === 'screenshot' || d.kind === 'bug') && Boolean(d.screenshot);
  state.includeBug = Boolean(d.bug);
  state.includeText = state.includeText && !d.bug;
  if (d.screenshot) {
    image = new Image();
    await new Promise((res, rej) => { image.onload = res; image.onerror = () => rej(new Error('the screenshot could not be read')); image.src = d.screenshot; });
    setupCanvas();
  }
  renderSource();

  const [pr, ag, mem] = await Promise.all([send({ type: 'projects' }), send({ type: 'agents' }), send({ type: 'memory-get' })]);
  if (!pr.projects) throw new Error(pr.error || 'Could not load the projects');
  state.projects = pr.projects.filter((p) => !p.archivedAt);
  state.agents = ag.agents ?? [];
  memory = mem.memory ?? memory;
  fill($('project'), state.projects.map((p) => ({ value: p.slug, label: p.name })));
  state.project = pickProject(state.projects, memory, d.url);
  $('project').value = state.project;

  $('mode').onchange = () => {
    state.mode = $('mode').value;
    if (state.mode === 'followup') void loadTasks().then(refresh);
    refresh();
  };
  $('taskFilter').oninput = () => { state.taskFilter = $('taskFilter').value; renderTasks(); };
  $('project').onchange = () => { state.project = $('project').value; projectChanged(); };
  $('agent').onchange = () => { state.agentName = $('agent').value; };
  $('kb').onchange = () => { state.kb = $('kb').value; refresh(); };
  $('prompt').oninput = () => { state.prompt = $('prompt').value; refresh(); };
  $('send').onclick = submit;
  // opened from a conversation in the side panel: the message goes to that task
  const wanted = params.get('task');
  if (wanted && /^[\w-]{1,64}$/.test(wanted)) {
    state.taskId = wanted;
    state.mode = 'followup';
    $('mode').value = 'followup';
    void loadTasks().then(refresh);
  }
  projectChanged();
  if (d.kind === 'bug') {
    $('prompt').placeholder = 'What went wrong? What did you expect to happen?';
    if (state.agents.some((a) => a.name === 'frontend')) { $('agent').value = 'frontend'; state.agentName = 'frontend'; }
  }
  const mic = await micButton($('prompt'), { onNeedPermission: () => void send({ type: 'open-mic' }) });
  if (mic) $('micSlot').append(mic);
  $('prompt').focus();
}

async function submit() {
  $('send').disabled = true;
  status('Sending…');
  const body = buildClip({ ...state, screenshot: state.includeShot && image && state.mode !== 'kb' ? screenshotBase64() : null });
  const r = await send({ type: 'clip', body, remember: state.mode === 'followup' ? undefined : { site: siteKey(state.draft.url), project: state.project } });
  if (!r?.ok && r?.error) {
    status(r.error, 'bad');
    refresh();
    return;
  }
  status('');
  const done = $('done');
  done.hidden = false;
  const kind = r.result.kind;
  done.replaceChildren(
    el('strong', { className: 'ok', textContent: kind === 'task' ? 'Task created' : kind === 'followup' ? `Sent to “${r.result.title || 'the task'}”` : 'Saved to the knowledge base' }),
    kind === 'kb'
      ? el('span', { className: 'muted', textContent: `“${r.result.kb}” — it is being indexed.` })
      : el('button', { type: 'button', textContent: 'Open the task', onclick: () => send({ type: 'open', path: r.result.path }) }),
    el('button', { type: 'button', textContent: 'Close', onclick: () => window.close() }),
  );
  $('send').hidden = true;
}

init().catch((e) => {
  $('source').replaceChildren(el('p', { className: 'bad', textContent: e.message || String(e) }));
  $('send').hidden = true;
});
