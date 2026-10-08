#!/usr/bin/env node
// ----------------------------------------------------------------------
// Console access to the built-in admin agent — the same assistant as the dashboard's chat bubble, from a terminal on
// the server. Useful on a headless box, or for first-time setup before the dashboard is reachable.
//
//   aigentron-admin                 interactive chat (resumes your last console chat)
//   aigentron-admin --new           start a fresh chat
//   aigentron-admin "message"       one question, print the answer, exit
//   (see --help)
//
// Approvals the admin raises (agent edits, task cleanup, provider changes, …) are shown here and answered at the
// prompt; API keys are typed into a HIDDEN prompt and go straight to the server's secret endpoint — never through
// the chat or the model. No dependencies: Node >= 18 built-ins only. The server's HTTP API has no authentication,
// so this talks to localhost by default.
// ----------------------------------------------------------------------
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HELP = `Usage: aigentron-admin [options] [message...]

Options:
  --new              start a new chat instead of resuming the last one
  --url <base>       orchestrator base URL (default: auto-detect http://127.0.0.1:3001, then ORCHESTRATOR_PORT; or LDS_URL)
  --user <id>        act as this user id (sent as x-lds-user; default: the default operator)
  -h, --help         this help

In the chat:  /new  new chat · /cancel  stop the running reply · /status · /help · /exit
Approvals:    a = approve, d = deny, v = view the full content. Keys are asked for in a hidden prompt.`;

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { fresh: false, url: process.env.LDS_URL || '', user: process.env.LDS_USER || '', message: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-h' || a === '--help') {
    console.log(HELP);
    process.exit(0);
  } else if (a === '--new') opts.fresh = true;
  else if (a === '--url') opts.url = argv[++i] ?? '';
  else if (a === '--user') opts.user = argv[++i] ?? '';
  else opts.message.push(a);
}
const ONE_SHOT = opts.message.length > 0;

// ---- tiny terminal helpers --------------------------------------------------
const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const out = (s = '') => process.stdout.write(`${s}\n`);
const clearLine = () => {
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
};

let muted = false;
const sink = new Writable({
  write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk);
    cb();
  },
});
const rl = createInterface({ input: process.stdin, output: sink, terminal: isTTY });
const queue = [];
let waiter = null;
let closed = false;
rl.on('line', (line) => {
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(line);
  } else queue.push(line);
});
rl.on('close', () => {
  closed = true;
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(null);
  }
});
let onSigint = () => process.exit(130);
rl.on('SIGINT', () => onSigint());

/** Next input line (null at EOF). Prompts are printed by us so hidden entry can mute echo. */
function nextLine() {
  if (queue.length) return Promise.resolve(queue.shift());
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => {
    waiter = resolve;
  });
}
async function ask(prompt, { hidden = false } = {}) {
  process.stdout.write(prompt);
  muted = hidden;
  const line = await nextLine();
  muted = false;
  if (hidden && isTTY) process.stdout.write('\n');
  return line;
}

// ---- API ------------------------------------------------------------------
let BASE = '';
async function detectBase() {
  const candidates = opts.url
    ? [opts.url]
    : ['http://127.0.0.1:3001', process.env.ORCHESTRATOR_PORT ? `http://127.0.0.1:${process.env.ORCHESTRATOR_PORT}` : ''].filter(Boolean);
  for (const base of candidates) {
    try {
      const r = await fetch(`${base.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return base.replace(/\/$/, '');
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.user ? { 'x-lds-user': opts.user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = Array.isArray(j.message) ? j.message.join('; ') : (j.message ?? text);
    } catch {
      /* keep raw text */
    }
    throw new Error(`${res.status} ${msg}`.slice(0, 400));
  }
  return text ? JSON.parse(text) : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- chat state -------------------------------------------------------------
const stateFile = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'aigentron', 'admin-chat.json');
function loadState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(s) {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(s));
  } catch {
    /* not fatal: the chat just won't be resumed next time */
  }
}

let taskId = null;
const shown = new Set();

async function printNewReplies() {
  const events = await api(`/tasks/${taskId}/transcript`);
  for (const e of events) {
    const key = `${e.agentSessionId}:${e.seq}`;
    if (shown.has(key)) continue;
    shown.add(key);
    if (e.kind === 'result' && (e.text ?? '').trim()) out(`\n${bold('admin')}${dim(' ›')} ${e.text.trim()}\n`);
  }
}
async function markExistingAsSeen() {
  for (const e of await api(`/tasks/${taskId}/transcript`)) shown.add(`${e.agentSessionId}:${e.seq}`);
}

// ---- approvals ---------------------------------------------------------------
const tail = (name) => String(name).split('__').pop();
const trunc = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

async function describe(a) {
  const t = tail(a.toolName);
  const i = a.toolInput ?? {};
  const lines = [`${bold('Approval needed')}  ${dim(a.summary)}`, `${dim('why:')} ${a.reason}`];
  let full = null;
  if (t === 'propose_agent' || t === 'propose_skill') {
    lines.push(`${t === 'propose_agent' ? 'Agent' : 'Skill'} ${bold(i.name)} — content:`);
    const body = String(i.content ?? '').split('\n');
    lines.push(...body.slice(0, 22).map((l) => `  │ ${l}`));
    if (body.length > 22) lines.push(dim(`  … ${body.length - 22} more lines (v = view all)`));
    full = String(i.content ?? '');
  } else if (t === 'propose_task_action') {
    const ids = Array.isArray(i.taskIds) ? i.taskIds : [];
    lines.push(`${bold(String(i.action).toUpperCase())} ${ids.length} task(s)${i.reason ? ` — ${i.reason}` : ''}`);
    for (const id of ids.slice(0, 12)) {
      try {
        const task = await api(`/tasks/${id}`);
        lines.push(`  ${id}  ${trunc(task.title, 60)} — ${task.status}`);
      } catch {
        lines.push(`  ${id}  (not found)`);
      }
    }
    if (ids.length > 12) lines.push(dim(`  … and ${ids.length - 12} more`));
  } else if (t === 'propose_agent_delete') {
    lines.push(`Delete agent ${bold(i.name)} (a snapshot is kept)${i.reason ? ` — ${i.reason}` : ''}`);
  } else if (t === 'propose_provider') {
    lines.push(
      `Provider ${bold(i.name)}${i.makeDefault ? '  → make it the DEFAULT' : ''}`,
      `  kind: ${i.kind}   model: ${i.model}   auth: ${i.authMode}   base URL: ${i.baseUrl || '(family default)'}`,
      dim('  (no secret in this request — a stored key is left untouched)'),
    );
  } else if (t === 'propose_batch') {
    const items = Array.isArray(i.items) ? i.items : [];
    lines.push(`${bold(`${items.length} changes in ONE approval`)}${i.reason ? ` — ${i.reason}` : ''}`);
    const title = (it) => {
      const a = it.args ?? {};
      switch (it.kind) {
        case 'agent': return `agent "${a.name}" (create or replace)`;
        case 'skill': return `skill "${a.name}" (create or replace)`;
        case 'agent_delete': return `DELETE agent "${a.name}"`;
        case 'provider': return `provider "${a.name}" (${a.kind}, ${a.model}, ${a.authMode})${a.makeDefault ? ' → DEFAULT' : ''}`;
        case 'settings': return `settings: ${Object.keys(a.changes ?? {}).join(', ')}`;
        case 'task': return `start task for "${a.agentName}"${a.title ? ` — ${a.title}` : ''}`;
        case 'task_action': return `${String(a.action).toUpperCase()} ${(a.taskIds ?? []).length} task(s)`;
        default: return it.kind;
      }
    };
    items.forEach((it, n) => lines.push(`  ${n + 1}. ${title(it)}`));
    lines.push(dim('  applied in this order; each is journaled and revertible; a failure skips the rest (v = view every item in full)'));
    full = items.map((it, n) => `── ${n + 1}. ${title(it)}\n${typeof it.args?.content === 'string' ? it.args.content : typeof it.args?.prompt === 'string' ? it.args.prompt : JSON.stringify(it.args, null, 2)}`).join('\n\n');
  } else if (t === 'propose_task') {
    lines.push(`Start a task for agent ${bold(i.agentName)}${i.title ? ` — "${i.title}"` : ''}${i.reason ? ` (${i.reason})` : ''}`);
    const body = String(i.prompt ?? '').split('\n');
    lines.push(...body.slice(0, 12).map((l) => `  │ ${l}`));
    if (body.length > 12) lines.push(dim(`  … ${body.length - 12} more lines (v = view all)`));
    lines.push(dim("  starts immediately and uses that agent's provider"));
    full = String(i.prompt ?? '');
  } else if (t === 'propose_settings') {
    let cur = {};
    try {
      cur = await api('/settings');
    } catch {
      /* show only the new values */
    }
    const show = (v) => (v === null || v === undefined || v === '' ? '(empty)' : trunc(String(v).replace(/\n/g, ' ⏎ '), 200));
    lines.push(`Change platform settings${i.reason ? ` — ${i.reason}` : ''}`);
    for (const [k, v] of Object.entries(i.changes ?? {})) lines.push(`  ${bold(k)}: ${show(cur[k])}  →  ${show(v)}`);
    lines.push(dim('  (previous values are journaled; revertible from the chat)'));
    full = JSON.stringify(i.changes, null, 2);
  } else if (t === 'propose_undo') {
    let e = null;
    try {
      e = await api(`/admin-audit/${i.changeId}`);
    } catch {
      /* not found */
    }
    lines.push(`Revert admin change ${bold(i.changeId)}${i.reason ? ` — ${i.reason}` : ''}`, e ? `  ${e.ts.slice(0, 16).replace('T', ' ')}  ${e.summary}` : '  (entry not found)');
  } else if (t === 'propose_cleanup') {
    let dry = null;
    try {
      dry = await api('/maintenance/cleanup', {
        method: 'POST',
        body: { dryRun: true, runs: i.runs !== false, worktrees: i.worktrees === true, deleteBranches: i.deleteBranches === true, olderThanDays: i.olderThanDays },
      });
    } catch {
      /* numbers are a nicety */
    }
    lines.push(
      `Clean up leftovers${i.olderThanDays ? ` older than ${i.olderThanDays} day(s)` : ''}${i.reason ? ` — ${i.reason}` : ''}`,
      dry ? `  run folders ${dry.runsRemoved} (${(dry.runBytes / 1048576).toFixed(1)} MB) · worktrees ${dry.worktreesRemoved} · branches ${dry.branchesDeleted}` : '',
      i.deleteBranches ? c('31', '  ⚠ deletes agent/task-* branches — commits never pushed are LOST') : dim('  branches are kept'),
    );
  } else if (a.toolInput && Object.keys(i).length) {
    full = JSON.stringify(i, null, 2);
    lines.push(dim(trunc(JSON.stringify(i), 300)));
  }
  return { text: lines.filter(Boolean).join('\n'), full };
}

/** Answer the approvals that block OUR chat task. Returns false when input ended before an answer. */
async function handleApprovals() {
  const pending = (await api('/approvals?status=pending')).filter((a) => a.taskId === taskId);
  for (const a of pending) {
    if (tail(a.toolName) === 'request_secret') {
      const i = a.toolInput ?? {};
      const label = i.target === 'github_token' ? 'GitHub token' : `API key / token for provider "${i.name}"`;
      out(`\n${bold('Secret needed')}  ${label}${i.reason ? `\n${dim(i.reason)}` : ''}`);
      out(dim('Typed input is hidden and goes straight to the server — the model never sees it. Empty line = cancel.'));
      const value = await ask('  value › ', { hidden: true });
      if (value === null) return false;
      if (!value.trim()) {
        await api(`/approvals/${a.id}/decision`, { method: 'POST', body: { decision: 'deny' } });
        out(dim('  cancelled'));
      } else {
        try {
          await api(`/approvals/${a.id}/secret`, { method: 'POST', body: { value } });
          out(c('32', '  saved ✓'));
        } catch (e) {
          out(c('31', `  could not save: ${e.message}`));
        }
      }
      continue;
    }
    const { text, full } = await describe(a);
    out(`\n${text}`);
    for (;;) {
      const ans = (await ask(`  ${bold('[a]')}pprove / ${bold('[d]')}eny${full ? ` / ${bold('[v]')}iew all` : ''} › `))?.trim().toLowerCase();
      if (ans === null || ans === undefined) return false;
      if (ans === 'v' && full) {
        out(full);
        continue;
      }
      if (ans === 'a' || ans === 'approve' || ans === 'y' || ans === 'yes') {
        try {
          await api(`/approvals/${a.id}/decision`, { method: 'POST', body: { decision: 'approve' } });
          out(c('32', '  approved ✓'));
        } catch (e) {
          out(c('31', `  ${e.message}`));
        }
        break;
      }
      if (ans === 'd' || ans === 'deny' || ans === 'n' || ans === 'no' || ans === '') {
        await api(`/approvals/${a.id}/decision`, { method: 'POST', body: { decision: 'deny' } }).catch(() => undefined);
        out(dim('  denied'));
        break;
      }
    }
  }
  return true;
}

// ---- conversation -------------------------------------------------------------
let cancelRequested = false;
async function waitForReply() {
  const spin = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let n = 0;
  onSigint = () => {
    cancelRequested = true;
  };
  try {
    for (;;) {
      if (cancelRequested) {
        cancelRequested = false;
        await api(`/tasks/${taskId}/cancel`, { method: 'POST' }).catch(() => undefined);
        out(dim('\n(reply cancelled)'));
        return 'cancelled';
      }
      const t = await api(`/tasks/${taskId}`);
      await printNewReplies();
      if (t.status === 'needs_approval') {
        clearLine();
        const ok = await handleApprovals();
        if (!ok) return 'input-closed';
        continue;
      }
      if (t.status === 'queued' || t.status === 'running') {
        if (process.stdout.isTTY) process.stdout.write(`\r${dim(`${spin[n++ % spin.length]} admin is working… (Ctrl+C to stop)`)}`);
        await sleep(900);
        continue;
      }
      clearLine();
      if (t.status === 'failed' || t.status === 'stalled') out(c('31', `The reply ended with status "${t.status}"${t.error ? `: ${trunc(t.error, 300)}` : ''}. Check the default provider (Settings → Providers).`));
      return t.status;
    }
  } finally {
    onSigint = () => process.exit(130);
  }
}

async function send(text) {
  if (!taskId) {
    const t = await api('/tasks', { method: 'POST', body: { prompt: text, title: 'Chat with admin (console)', agentName: 'admin', autostart: true } });
    taskId = t.id;
    saveState({ base: BASE, taskId });
  } else {
    await api(`/tasks/${taskId}/follow-up`, { method: 'POST', body: { prompt: text } });
  }
  return waitForReply();
}

async function resumeOrFresh() {
  const st = loadState();
  if (!opts.fresh && st.taskId && st.base === BASE) {
    try {
      const t = await api(`/tasks/${st.taskId}`);
      if (t.agentName === 'admin') {
        taskId = t.id;
        await markExistingAsSeen();
        return true;
      }
    } catch {
      /* the task is gone — start fresh */
    }
  }
  return false;
}

async function main() {
  BASE = await detectBase();
  if (!BASE) {
    console.error('Cannot reach the orchestrator (tried http://127.0.0.1:3001 and ORCHESTRATOR_PORT). Is it running? Use --url or LDS_URL.');
    process.exit(2);
  }
  try {
    await api('/agents/admin');
  } catch {
    console.error('The built-in "admin" agent is not available on this instance (it is added on first start of release 0.1.27+).');
    process.exit(2);
  }
  const resumed = await resumeOrFresh();
  if (!ONE_SHOT) {
    out(`${bold('Aigentron admin')} ${dim(`— console chat · ${BASE}`)}`);
    out(dim(resumed ? 'Resumed your last console chat (/new for a fresh one). /help for commands.' : 'Describe what you want to set up. /help for commands, /exit to leave.'));
  }

  if (ONE_SHOT) {
    const status = await send(opts.message.join(' '));
    process.exit(status === 'done' ? 0 : status === 'input-closed' ? 3 : 1);
  }

  for (;;) {
    const line = await ask(`\n${bold('you')}${dim(' ›')} `);
    if (line === null) break;
    const text = line.trim();
    if (!text) continue;
    if (text === '/exit' || text === '/quit') break;
    if (text === '/help') {
      out(HELP);
      continue;
    }
    if (text === '/new') {
      taskId = null;
      saveState({});
      out(dim('New chat — your next message starts it.'));
      continue;
    }
    if (text === '/status') {
      if (!taskId) out(dim('No chat yet.'));
      else {
        const t = await api(`/tasks/${taskId}`);
        out(dim(`chat task ${taskId} · status ${t.status}`));
      }
      continue;
    }
    if (text === '/cancel') {
      if (taskId) await api(`/tasks/${taskId}/cancel`, { method: 'POST' }).catch(() => undefined);
      out(dim('Stopped.'));
      continue;
    }
    try {
      const status = await send(text);
      if (status === 'input-closed') break;
    } catch (e) {
      out(c('31', `Error: ${e.message}`));
    }
  }
  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});
