#!/usr/bin/env node
// ----------------------------------------------------------------------
// Aigentron interactive setup wizard — a CLI guide for first-run
// configuration, alternative to clicking through the dashboard by hand.
// Pure HTTP client against the orchestrator's REST API (`/api/...`), so it
// works identically regardless of how the server was installed:
//   - bare-metal (install-bare.sh): run directly — `node infra/setup-wizard.mjs`
//   - Docker (install.sh): `docker exec -it <container> node /app/infra/setup-wizard.mjs`
//     (Node only exists inside the container in that profile), or directly on
//     the host if you happen to have Node there too, hitting the published port.
//   - full dev stack (`make up`): `node infra/setup-wizard.mjs` from the repo root.
//
// No external dependencies — only Node built-ins (readline, fetch, child_process).
// Not auto-launched by install.sh/install-bare.sh: both installers are meant to
// run via `curl -fsSL ... | sh`, so stdin is the curl pipe, not a real TTY —
// an inline interactive prompt would just hit EOF. Run this yourself afterward.
//
// Usage:
//   node infra/setup-wizard.mjs [--orchestrator-url http://localhost:3001] [--advanced]
// ----------------------------------------------------------------------
import { createInterface } from 'node:readline';
import { spawnSync, execSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

let BASE = 'http://localhost:3001';

// ---- terminal UI ----
//
// Arrow-key menus, y/n toggles and colours — built on one always-raw stdin reader (see readRawLine's history below). Colours follow the
// usual rules: off when output is not a terminal or NO_COLOR is set, forced on by FORCE_COLOR. When stdin/stdout is not a TTY (piped
// input, CI) every prompt falls back to a plain typed line, so scripted use keeps working.
const COLOR = (process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb') || Boolean(process.env.FORCE_COLOR);
const sgr = (open, close = 39) => (s) => (COLOR ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
const c = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  red: sgr(31),
  green: sgr(32),
  yellow: sgr(33),
  blue: sgr(34),
  magenta: sgr(35),
  cyan: sgr(36),
  gray: sgr(90),
};
const INTERACTIVE = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const cols = () => process.stdout.columns || 80;
const fit = (s, max) => (stripAnsi(s).length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s);

// Restore the terminal when we are killed, not only on a normal exit.
for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(128 + (sig === 'SIGTERM' ? 15 : 1)));

process.on('exit', () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  if (process.stdout.isTTY) process.stdout.write('\u001b[?25h'); // never leave the cursor hidden
});

/** Lines that start like a result get their colour automatically, so steps just `log('  ✓ done')`. */
function log(msg = '') {
  const m = String(msg);
  if (!COLOR) return console.log(m);
  if (/^\s*✓/.test(m)) return console.log(c.green(m));
  if (/^\s*✗/.test(m)) return console.log(c.red(m));
  if (/^\s*⚠|^\s*warning/i.test(m)) return console.log(c.yellow(m));
  if (/^\s*\(.*\)\s*$/.test(m)) return console.log(c.gray(m));
  console.log(m);
}
function header(title) {
  const line = '━'.repeat(Math.max(4, Math.min(60, cols() - 2) - title.length - 4));
  console.log(`\n${c.cyan(c.bold(`━━ ${title} `))}${c.cyan(line)}`);
}
function banner(title, sub) {
  console.log(`\n${c.magenta(c.bold(`◆ ${title}`))}${sub ? `  ${c.gray(sub)}` : ''}`);
}

// Every prompt — masked or not — reads stdin itself in raw mode; readline's own `.question()` is never used to capture input
// (`rl` is paused right after creation in main()). Mixing the two once leaked a pasted API key in cleartext (readline's listener
// echoed it before the masking reader took over), so there is exactly one reader. The trade-off is no readline history/arrow
// editing inside a text field; menus below use the arrow keys instead.
const KEY_RE = /\u001b\[[0-9;]*[A-Za-z~]|\u001b[A-Za-z]|[\s\S]/gu;
const ESC_NAMES = { '\u001b[A': 'up', '\u001b[B': 'down', '\u001b[C': 'right', '\u001b[D': 'left', '\u001b[H': 'home', '\u001b[F': 'end', '\u001bOA': 'up', '\u001bOB': 'down' };

/** Feeds `onKey(name, raw)` for every key in every chunk until it returns true (finished). */
/** Thrown when the user presses Esc: "cancel what I am doing" — the menu loops catch it and go one level back. */
class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

// Keys that arrived in the same chunk as the Enter that finished the previous prompt (piped or pasted input) wait here for the next one.
let leftover = [];

function readKeys(onKey) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk) => {
      const keys = [...leftover, ...(chunk.toString('utf8').match(KEY_RE) ?? [])];
      leftover = [];
      for (let n = 0; n < keys.length; n++) {
        const raw = keys[n];
        const name = ESC_NAMES[raw] ?? (raw === '\r' || raw === '\n' ? 'enter' : raw === '\u0003' ? 'ctrl-c' : raw === '\u007f' || raw === '\b' ? 'backspace' : raw === '\t' ? 'tab' : raw === '\u001b' ? 'esc' : raw);
        if (name === 'ctrl-c') {
          stdin.removeListener('data', onData);
          process.stdout.write('\u001b[?25h');
          log(`\n${c.red('aborted')}`);
          process.exit(130);
        }
        if (name === 'esc' && !String(raw).startsWith('\u001b[') && keys.length === 1) {
          stdin.removeListener('data', onData);
          stdin.pause();
          leftover = [];
          reject(new Cancelled());
          return;
        }
        if (onKey(name, raw)) {
          stdin.removeListener('data', onData);
          // Stop reading between prompts, or the open stdin keeps the process alive after the last step ("hangs on Done").
          // Raw mode stays on, so keys typed in the gap are still not echoed.
          stdin.pause();
          leftover = keys.slice(n + 1);
          resolve();
          return;
        }
      }
    };
    stdin.on('data', onData);
    if (leftover.length) onData(Buffer.alloc(0)); // answers that were already waiting
  });
}

function readRawLine(query, { mask = false } = {}) {
  return new Promise((resolve, reject) => {
    process.stdout.write(query);
    let buf = '';
    readKeys((name, raw) => {
      if (name === 'enter') {
        process.stdout.write('\n');
        resolve(buf.trim());
        return true;
      }
      if (name === 'backspace') {
        if (buf.length) {
          buf = buf.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (raw.length >= 1 && raw >= ' ' && !raw.startsWith('\u001b') && !ESC_NAMES[raw]) {
        buf += raw;
        process.stdout.write(mask ? '*' : raw);
      }
      return false;
    }).catch((e) => {
      process.stdout.write('\n');
      reject(e);
    });
  });
}

const qMark = () => c.cyan('?');
const tick = () => c.green('✔');

function qp(_rl, query) {
  return readRawLine(query);
}

async function prompt(rl, query, def) {
  const suffix = def !== undefined && def !== '' ? ` ${c.gray(`(${def})`)}` : '';
  const answer = (await qp(rl, `${qMark()} ${c.bold(query)}${suffix} ${c.cyan('›')} `)).trim();
  return answer || def || '';
}

/** Masked input — `*` per character; the real value is never echoed. */
function promptSecret(_rl, query) {
  return readRawLine(`${qMark()} ${c.bold(query.replace(/:\s*$/, ''))} ${c.cyan('›')} `, { mask: true });
}

/**
 * Menu: ↑/↓ (or j/k, or a number) to move, Enter to choose. `options` are strings or `{ value, label?, hint? }`. Returns the value.
 * `def` is the value highlighted first.
 */
async function select(query, options, def, { back, exit } = {}) {
  const items = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : { label: o.value, ...o }));
  if (!INTERACTIVE) {
    for (;;) {
      const names = items.map((i) => i.value);
      const a = (await readRawLine(`${query} [${names.join('/')}]${def ? ` (${def})` : ''}: `)).trim();
      if (!a) return def ?? names[0];
      const hit = names.find((n) => n.toLowerCase() === a.toLowerCase());
      if (hit) return hit;
      log(`  please choose one of: ${names.join(', ')}`);
    }
  }
  // The last entry always leads out: "← Back" one level up, or "Exit" when there is no level above (`exit`). Menus that already
  // end with their own "done / back" entry pass `back` and are left as they are.
  const BACK = '\u0000back';
  if (back === undefined) items.push({ value: BACK, label: exit ? 'Exit' : '← Back' });
  let idx = Math.max(0, items.findIndex((i) => i.value === def));
  const width = cols() - 6;
  const render = (first) => {
    if (!first) process.stdout.write(`\u001b[${items.length}A`);
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      const on = n === idx;
      const num = n < 9 ? c.gray(`${n + 1}`) : ' ';
      const text = fit(`${it.label}${it.hint ? `  ${stripAnsi(it.hint)}` : ''}`, width);
      const [label, hint] = it.hint ? [text.slice(0, it.label.length), text.slice(it.label.length)] : [text, ''];
      process.stdout.write(`\u001b[2K${on ? c.cyan('❯') : ' '} ${num} ${on ? c.cyan(c.bold(label)) : label}${c.gray(hint)}\n`);
    }
  };
  // header on ONE line (the menu is redrawn by moving the cursor up a fixed number of lines — a wrapped header would break that)
  const hintFull = `(↑/↓, Enter · Esc ${back !== undefined ? 'back' : 'cancel'})`;
  const room = Math.max(20, cols() - 3);
  const hintShown = 2 + query.length + 1 + hintFull.length <= room ? hintFull : '';
  process.stdout.write(`${qMark()} ${c.bold(fit(query, room - 2))}${hintShown ? ` ${c.gray(hintShown)}` : ''}\n\u001b[?25l`);
  render(true);
  try {
    await readKeys((name) => {
    if (name === 'up' || name === 'k') idx = (idx - 1 + items.length) % items.length;
    else if (name === 'down' || name === 'j' || name === 'tab') idx = (idx + 1) % items.length;
    else if (name === 'home') idx = 0;
    else if (name === 'end') idx = items.length - 1;
    else if (/^[1-9]$/.test(name) && Number(name) <= items.length) idx = Number(name) - 1;
    else if (name === 'enter') return true;
    render(false);
    return false;
    });
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    process.stdout.write(`\u001b[${items.length + 1}A\u001b[J${c.gray(`↩ ${query}`)}\n\u001b[?25h`);
    if (back !== undefined) return back;
    throw e;
  }
  if (items[idx].value === BACK) {
    process.stdout.write(`\u001b[${items.length + 1}A\u001b[J${c.gray(`↩ ${query}`)}\n\u001b[?25h`);
    throw new Cancelled();
  }
  // collapse the menu to one line with the answer
  process.stdout.write(`\u001b[${items.length + 1}A\u001b[J${tick()} ${c.bold(fit(query, Math.max(10, cols() - 8 - items[idx].label.length)))} ${c.cyan(items[idx].label)}\n\u001b[?25h`);
  return items[idx].value;
}

/** Yes/No: ←/→ or y/n toggles, Enter confirms (the default is preselected). */
async function confirm(query, def = false) {
  if (!INTERACTIVE) {
    const a = (await readRawLine(`${query} (${def ? 'Y/n' : 'y/N'}): `)).trim().toLowerCase();
    return a ? /^y(es)?$/.test(a) : def;
  }
  let yes = def;
  // Everything is kept on ONE terminal line: the line is redrawn in place with \r, which only works if it never wraps (a wrapped
  // line left a stale copy behind on every key press). Too narrow → drop the key hint first, then shorten the question.
  const draw = () => {
    const room = Math.max(20, cols() - 3);
    const choice = 17; // "● Yes  ○ No" plus spacing
    let hint = '(←/→, y/n, Enter · Esc cancel)';
    let q = query;
    if (2 + q.length + 2 + choice + 2 + hint.length > room) hint = '(Esc cancel)';
    if (2 + q.length + 2 + choice + 2 + hint.length > room) hint = '';
    if (2 + q.length + 2 + choice > room) q = `${q.slice(0, Math.max(8, room - 2 - 2 - choice - 1))}…`;
    process.stdout.write(`\r\u001b[2K${qMark()} ${c.bold(q)}  ${yes ? c.green(c.bold('● Yes')) : c.gray('○ Yes')}  ${yes ? c.gray('○ No') : c.red(c.bold('● No'))}${hint ? `  ${c.gray(hint)}` : ''}`);
  };
  process.stdout.write('\u001b[?25l');
  draw();
  try {
    await readKeys((name) => {
    if (name === 'left' || name === 'right' || name === 'tab' || name === 'h' || name === 'l') yes = !yes;
    else if (name === 'y' || name === 'Y') yes = true;
    else if (name === 'n' || name === 'N') yes = false;
    else if (name === 'enter') return true;
    draw();
    return false;
    });
  } catch (e) {
    process.stdout.write(`\r\u001b[2K${c.gray(`↩ ${fit(query, cols() - 4)}`)}\n\u001b[?25h`);
    throw e;
  }
  process.stdout.write(`\r\u001b[2K${tick()} ${c.bold(fit(query, Math.max(10, cols() - 8)))} ${yes ? c.green('Yes') : c.red('No')}\n\u001b[?25h`);
  return yes;
}

const promptYesNo = (_rl, query, def = false) => confirm(query, def);
const promptChoice = (_rl, query, options, def, opts) => select(query, options, def ?? (typeof options[0] === 'string' ? options[0] : options[0].value), opts);

/** Same as promptChoice, with an extra "none" entry on top. */
async function promptChoiceOptional(_rl, query, options) {
  if (!options.length) return undefined;
  const none = '\u0000none';
  const v = await select(query, [{ value: none, label: '(none)' }, ...options], none);
  return v === none ? undefined : v;
}

function toIntOrUndef(s) {
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}
function toCsvOrUndef(list) {
  return list && list.length ? list.join(',') : undefined;
}
function splitCsv(s) {
  return (s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Best-effort provider kind from a base URL — mirrors litellm.service.ts's
 *  defaultKind() (server-side) and ProviderForm.tsx's client-side copy of
 *  the same heuristic; a form pre-fill/suggestion, never authoritative. */
function guessKind(baseUrl) {
  const u = (baseUrl || '').toLowerCase();
  if (!u || u.includes('api.anthropic.com') || u.includes('api.z.ai')) return 'anthropic';
  // Some vendors expose a dedicated Anthropic-protocol-compatible path
  // alongside their native one (e.g. DeepSeek's `.../anthropic` — real,
  // documented, not a guess) — prefer 'anthropic' whenever the URL itself
  // says so, regardless of vendor.
  if (/\/anthropic\/?$/.test(u)) return 'anthropic';
  if (u.includes('api.deepseek.com')) return 'deepseek';
  if (u.includes('api.openai.com')) return 'openai';
  if (u.includes('11434') || u.includes('ollama')) return 'ollama';
  return 'openai';
}

// ---- orchestrator REST client ----

// If the dashboard password is already set, pass it as LDS_ADMIN_PASSWORD (it is used once to sign in).
let sessionToken = '';
/**
 * If the server has a sign-in password, sign in before doing anything (otherwise every call is rejected and the lists look empty).
 * LDS_ADMIN_PASSWORD / LDS_ADMIN_USER work for scripts; interactively we ask: who you are (when several users have a password), then
 * the password in a hidden prompt.
 */
async function ensureSignedIn(rl) {
  const status = await fetch(`${BASE}/api/auth/status`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  if (!status?.configured || status.authenticated) return;
  if (process.env.LDS_ADMIN_PASSWORD) {
    await signInFromEnv();
    log('  ✓ signed in');
    return;
  }
  if (!INTERACTIVE) throw new Error('The server has a sign-in password. Set LDS_ADMIN_PASSWORD=<password> (and LDS_ADMIN_USER=<name>) in the environment.');
  log('  This server asks for a password.');
  const users = status.users ?? [];
  const user =
    users.length > 1 ? await promptChoice(rl, 'Who are you?', users.map((u) => ({ value: u.id, label: u.displayName, hint: `(${u.role})` })), users[0].id) : users[0]?.id;
  for (let attempt = 0; attempt < 3; attempt++) {
    const password = await promptSecret(rl, 'Password: ');
    const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user, password }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.token) {
      sessionToken = j.token;
      log('  ✓ signed in');
      return;
    }
    log(`  ✗ ${j.error || `sign-in failed (${r.status})`}`);
    if (r.status === 429) break;
  }
  throw new Error('could not sign in — if you forgot the password: aigentron reset-password');
}

async function signInFromEnv() {
  const password = process.env.LDS_ADMIN_PASSWORD;
  if (!password) throw new Error('The server has a sign-in password. Re-run with LDS_ADMIN_PASSWORD=<password> (and LDS_ADMIN_USER=<name> if several users have one) in the environment.');
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: process.env.LDS_ADMIN_USER || undefined, password }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(`sign-in failed: ${j.error || r.status}`);
  sessionToken = j.token;
}
async function api(method, path, body, retried = false) {
  const headers = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}) };
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) {
    await signInFromEnv();
    return api(method, path, body, true);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.message || json?.error || res.statusText;
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${Array.isArray(msg) ? msg.join('; ') : msg}`);
  }
  return json;
}
const apiGet = (path) => api('GET', path);
const apiPost = (path, body) => api('POST', path, body ?? {});
const apiPut = (path, body) => api('PUT', path, body ?? {});

async function waitForOrchestrator(maxTries = 10) {
  for (let i = 0; i < maxTries; i++) {
    try {
      return await apiGet('/health');
    } catch (e) {
      if (i === 0) log(`  waiting for the orchestrator at ${BASE} ...`);
      if (i === maxTries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `claude setup-token` fully interactively — stdio entirely inherited
 * from this TTY, nothing captured. Piping its stdout (an earlier version of
 * this function did, to auto-scrape the token) hides the login URL/prompts
 * the user needs to see and act on, so the process just sits there waiting
 * for a browser confirmation the user was never shown how to give — a real
 * deadlock found live, not a hypothetical. The caller always prompts for the
 * token manually afterward instead of trying to auto-capture it.
 */
function runClaudeSetupTokenInteractive() {
  log('  Launching `claude setup-token` — complete the login it opens, then come back here.');
  const res = runInteractive('claude', ['setup-token']);
  if (res.status !== 0) {
    log('  (`claude setup-token` did not exit successfully — you can still paste a token manually below)');
  }
}

/** Shared oauth-token entry flow: offer to launch `claude setup-token`
 *  inline, then always end with a manual paste (see
 *  runClaudeSetupTokenInteractive's note on why this never auto-captures). */
async function promptOauthSecret(rl, label) {
  if (commandExists('claude') && (await promptYesNo(rl, 'Run `claude setup-token` now (opens an interactive login)?', true))) {
    runClaudeSetupTokenInteractive();
  } else {
    log('  If `claude` isn\'t available here (e.g. inside a `docker exec` session), run');
    log('  `claude setup-token` (or `scripts/cli-auth.sh <name>`) on a machine where it works,');
    log('  then paste the resulting token below.');
  }
  log('  Note: tokens from `claude setup-token` expire after 1 year — repeat this to rotate one.');
  log(c.gray('  Copy the token it printed (the long line starting with sk-ant-oat…) and paste it below — it stays hidden. Esc cancels.'));
  for (;;) {
    const token = (await promptSecret(rl, `${label}: `)).replace(/\s+/g, '');
    if (!token) {
      log('  ✗ nothing was entered — paste the token and press Enter (or Esc to cancel).');
      continue;
    }
    if (!/^sk-ant-/.test(token) || token.length < 40) {
      log(`  ✗ that does not look like a Claude token (${token.length} characters, expected sk-ant-… and about 100). Paste it again.`);
      continue;
    }
    log(`  ✓ token received (${token.length} characters, hidden)`);
    return token;
  }
}

// ---- steps ----

// ---- Connection: how this wizard reaches the server (asked once, then remembered) ----

const SAVED_FILE = join(homedir(), '.config', 'aigentron', 'wizard.json');
function loadSaved() {
  try {
    return JSON.parse(readFileSync(SAVED_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveSaved(obj) {
  try {
    mkdirSync(dirname(SAVED_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(SAVED_FILE, JSON.stringify(obj), { mode: 0o600 });
  } catch {
    /* remembering is a convenience only */
  }
}

async function askConnection(rl, current) {
  const mode = await promptChoice(
    rl,
    'How is Aigentron installed here?',
    [
      { value: 'docker', label: 'Docker', hint: '— the container install' },
      { value: 'bare-metal', label: 'Bare-metal', hint: '— a systemd service on this machine' },
      { value: 'not-sure', label: 'Not sure' },
    ],
    current.mode && ['docker', 'bare-metal', 'not-sure'].includes(current.mode) ? current.mode : 'not-sure',
    { exit: true },
  );
  const url = (await prompt(rl, 'Orchestrator URL', current.url || 'http://localhost:3001')).replace(/\/$/, '');
  return { mode, url };
}

/**
 * Where the server is. The `aigentron` command already knows (it passes AIGENTRON_MODE and ORCHESTRATOR_URL), so nothing is asked.
 * Run directly, the first launch asks once and remembers the answer (~/.config/aigentron/wizard.json); it can be changed later in
 * the "Connection" section. Silent when the server answers; only a failure says anything.
 */
async function stepConnection(rl, cliUrl, { force = false } = {}) {
  const saved = loadSaved();
  let mode = process.env.AIGENTRON_MODE || saved.mode;
  let url = cliUrl || process.env.ORCHESTRATOR_URL || saved.url;
  const known = Boolean(url) || Boolean(mode);
  if (force || !known) {
    header(force ? 'Connection' : 'First run — how to reach the server');
    if (force) log(`  Now: ${BASE}${mode ? ` (${mode})` : ''}`);
    ({ mode, url } = await askConnection(rl, { mode, url: url || BASE }));
    saveSaved({ mode, url });
  }
  BASE = (url || 'http://localhost:3001').replace(/\/$/, '');
  for (;;) {
    try {
      await waitForOrchestrator(force ? 3 : 4);
      if (force) log('  ✓ connected');
      return mode;
    } catch {
      log(`  ✗ could not reach ${BASE}/api/health.`);
      if (mode === 'docker') {
        log('  If Node isn\'t installed on this machine, run the wizard inside the container:  aigentron  (or docker exec -it <container> node /app/infra/setup-wizard.mjs)');
      }
      if (!INTERACTIVE) throw new Error('orchestrator unreachable — fix the URL and re-run');
      if (!(await promptYesNo(rl, 'Enter a different address?', true))) throw new Error('orchestrator unreachable');
      ({ mode, url } = await askConnection(rl, { mode, url: BASE }));
      saveSaved({ mode, url });
      BASE = url.replace(/\/$/, '');
    }
  }
}

/**
 * Rotate/update an existing provider's secret — e.g. an oauth-token that
 * expired (they're valid 1 year) or an api-key that got revoked. The wizard
 * previously had no path back to an already-configured provider at all;
 * scripts/cli-auth.sh could re-run against an existing name (PUT), but
 * re-authenticating via the wizard itself meant no way to actually apply the
 * new secret short of the dashboard. Returns every existing provider's name
 * (whether or not the operator rotated any), so the caller's "add another" /
 * "set default" / later agent-provider-picker steps see the full set, not
 * just ones created this session.
 */

/** Runs an interactive child (a login CLI) with the real terminal: cooked mode while it runs, raw mode back afterwards. */
function runInteractive(cmd, args, env = {}) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.resume();
  const res = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  process.stdin.pause();
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  return res;
}

/** ChatGPT-subscription sign-in for the Codex runtime: `codex login --device-auth` into the orchestrator's CODEX_HOME. */
async function codexSignIn(rl) {
  const info = await apiGet('/providers/codex-login').catch(() => null);
  if (!info) {
    log('  ✗ could not ask the orchestrator where the Codex sign-in lives.');
    return false;
  }
  if (info.loggedIn) {
    log(`  ✓ Codex is already signed in (${info.message}).`);
    if (!(await promptYesNo(rl, 'Sign in again (another account)?', false))) return true;
  }
  if (!commandExists(info.bin)) {
    log(`  ⚠ The Codex CLI ("${info.bin}") is not installed on this machine.`);
    log('    Run this wizard inside the container (docker exec -it <container> node /app/infra/setup-wizard.mjs),');
    log('    or install it here: npm i -g @openai/codex — then choose this again.');
    return false;
  }
  if (!existsSync(dirname(info.home))) {
    log(`  ⚠ The orchestrator keeps the Codex sign-in in ${info.home}, which is not on this machine.`);
    log('    Run this wizard where the orchestrator runs (docker exec -it … or on the server itself) to sign in.');
    return false;
  }
  try {
    mkdirSync(info.home, { recursive: true, mode: 0o700 });
  } catch (e) {
    log(`  ✗ cannot write ${info.home} (${e.code ?? e.message}).`);
    log('    The sign-in is stored in a protected folder — run the wizard as root: sudo aigentron providers');
    return false;
  }
  log(`  Starting the ChatGPT sign-in (device code). Open the link it prints in any browser and enter the code.`);
  log(c.gray(`  The login is stored in ${info.home}.`));
  const res = runInteractive(info.bin, ['login', '--device-auth'], { CODEX_HOME: info.home });
  const after = await apiGet('/providers/codex-login').catch(() => null);
  if (res.status === 0 && after?.loggedIn) {
    log('  ✓ signed in to ChatGPT');
    return true;
  }
  log(`  ✗ sign-in did not complete${after ? ` (${after.message})` : ''}. You can repeat it: choose Providers → edit → this provider.`);
  return false;
}

/** Claude subscription sign-in: `claude setup-token` mints a long-lived OAuth token that the user pastes back. */
async function claudeSignIn(rl) {
  return await promptOauthSecret(rl, 'OAuth token (starts with sk-ant-oat…)');
}

/** Offered when the provider cannot list models itself (e.g. a Claude subscription login) — the current ones, with a hint. */
const KNOWN_MODELS = {
  anthropic: [
    { id: 'claude-sonnet-5-5', hint: '— balanced, the usual choice' },
    { id: 'claude-opus-5-5', hint: '— strongest, slower and costlier' },
    { id: 'claude-haiku-4-5-20251001', hint: '— fastest and cheapest' },
  ],
};

const AUTH_METHODS = [
  { value: 'api-key', label: 'API key', hint: '— pay per use (Anthropic, OpenAI, DeepSeek, any compatible endpoint)' },
  { value: 'claude-login', label: 'Claude subscription', hint: '— sign in with Claude Pro/Max (claude setup-token)' },
  { value: 'codex-login', label: 'ChatGPT subscription (Codex)', hint: '— sign in with your ChatGPT plan (device code)' },
  { value: 'codex-key', label: 'OpenAI API key for Codex', hint: '— the Codex runtime, billed per use' },
  { value: 'auth-token', label: 'Bearer token', hint: '— for gateways that want Authorization: Bearer …' },
  { value: 'none', label: 'No authentication', hint: '— a local server such as Ollama' },
];

/** Print a provider test result. A subscription login (oauth-token) cannot be probed with a quick request — that is a note, not a failure. */
function reportTest(t, authMode) {
  if (t.ok) return log(`  ✓ works${t.latencyMs ? ` (${t.latencyMs} ms)` : ''}`);
  if (authMode === 'oauth-token') return log(c.gray(`  ⓘ ${t.error ?? 'cannot be checked with a quick request'} — the first real task will show it.`));
  log(`  ✗ test failed: ${t.error ?? 'unknown error'}`);
}

const isHttpUrl = (v) => {
  try {
    const u = new URL(v);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password;
  } catch {
    return false;
  }
};

/** Ask for an http(s) address until it is valid; blank = none (returns ''), '-' only when `allowClear`. */
async function askUrl(rl, question, current, { allowClear = false } = {}) {
  for (;;) {
    const v = (await prompt(rl, question, current || undefined)).trim();
    if (!v) return '';
    if (allowClear && v === '-') return '-';
    if (isHttpUrl(v)) return v;
    log('  ✗ that is not an http(s) address — e.g. https://api.example.com/v1 or http://localhost:11434');
  }
}

/** A key / token that must not be silently skipped: re-ask when empty, and only accept "no key" after an explicit yes. */
async function askKey(rl, question) {
  for (;;) {
    const v = (await promptSecret(rl, question)).trim();
    if (v) {
      log(`  ✓ received (${v.length} characters, hidden)`);
      return v;
    }
    if (await promptYesNo(rl, 'Nothing was entered. Create it without a key (add it later with Edit)?', false)) return '';
  }
}

/** One provider, in the order: name → how it signs in → protocol / address → model → limits → save → test. Returns its name or null. */
async function addProvider(rl, firstOne) {
  const taken = new Set((await apiGet('/providers').catch(() => [])).map((p) => p.name));
  let name = '';
  for (;;) {
    name = (await prompt(rl, 'Provider name (letters, digits, - and _)', firstOne ? 'claude-cloud' : undefined)).trim();
    if (!name) return null;
    if (!/^[\w-]{1,60}$/.test(name)) log('  ✗ use only letters, digits, - and _ (no spaces), up to 60 characters');
    else if (taken.has(name)) log(`  ✗ a provider named "${name}" already exists — pick another name, or go Back and use Edit`);
    else break;
  }
  const method = await promptChoice(rl, 'How does it sign in?', AUTH_METHODS, 'api-key');

  let kind;
  let authMode;
  let baseUrl;
  let secret;
  if (method === 'claude-login') {
    kind = 'anthropic';
    authMode = 'oauth-token';
    secret = await claudeSignIn(rl);
  } else if (method === 'codex-login') {
    kind = 'codex';
    authMode = 'codex-login';
    if (!(await codexSignIn(rl))) {
      if (!(await promptYesNo(rl, 'Create the provider anyway (sign in later)?', true))) return null;
    }
  } else if (method === 'codex-key') {
    kind = 'codex';
    authMode = 'api-key';
    secret = await askKey(rl, 'OpenAI API key (hidden)');
  } else {
    // Base URL first, then suggest the protocol from it (a vendor's URL usually tells which one it speaks).
    baseUrl = (await askUrl(rl, 'Base URL (blank = the vendor\'s native Anthropic API)')) || undefined;
    const suggested = method === 'none' && !baseUrl ? 'ollama' : guessKind(baseUrl);
    kind = await promptChoice(
      rl,
      'Protocol (what the endpoint speaks — LiteLLM uses it)',
      [
        { value: 'anthropic', label: 'Anthropic', hint: '— Claude API and Anthropic-compatible endpoints' },
        { value: 'openai', label: 'OpenAI', hint: '— OpenAI and OpenAI-compatible (Groq, vLLM, LM Studio…)' },
        { value: 'deepseek', label: 'DeepSeek' },
        { value: 'ollama', label: 'Ollama', hint: '— a local Ollama server' },
      ],
      suggested,
    );
    if (baseUrl && kind !== suggested) log(`  ⚠ "${baseUrl}" looked like a ${suggested} endpoint — make sure ${kind} is really what it speaks.`);
    if (method === 'none') {
      authMode = 'api-key';
    } else if (method === 'auth-token') {
      authMode = 'auth-token';
      secret = await askKey(rl, 'Bearer token (hidden)');
    } else {
      authMode = 'api-key';
      secret = await askKey(rl, 'API key (hidden)');
    }
  }

  let model;
  if (await promptYesNo(rl, 'List the available models from this provider?', true)) {
    try {
      const preview = await apiPost('/providers/models-preview', { kind, baseUrl: baseUrl || undefined, authMode, secret: secret || undefined });
      if (preview.ok && preview.models?.length) {
        model = await promptChoiceOptional(rl, 'Pick a model', preview.models);
      } else {
        log(`  (could not list models: ${preview.error || 'none returned'})`);
        const known = KNOWN_MODELS[kind];
        if (known) {
          const other = '\u0000other';
          const pick = await promptChoice(rl, 'Pick a model', [...known.map((m) => ({ value: m.id, label: m.id, hint: m.hint })), { value: other, label: 'Another model…', hint: '— type its name' }], known[0].id);
          if (pick !== other) model = pick;
        }
      }
    } catch (e) {
      log(`  (model preview failed: ${e.message})`);
    }
  }
  if (!model) model = await prompt(rl, 'Model name (blank only if every agent using this provider sets its own)');
  if (!model) {
    log('  ⚠ No model set — a task reaching this provider needs a model on the agent, or it fails with "No runnable provider".');
  }

  let rpm;
  let tpm;
  if (await promptYesNo(rl, 'Set rate limits (rpm/tpm)?', false)) {
    rpm = toIntOrUndef(await prompt(rl, 'Requests/min (blank = none)'));
    tpm = toIntOrUndef(await prompt(rl, 'Tokens/min (blank = none)'));
  }

  try {
    await apiPost('/providers', { name, kind, baseUrl: baseUrl || undefined, model, authMode, secret: secret || undefined, rpm, tpm });
    log(`  ✓ provider "${name}" created`);
  } catch (e) {
    log(`  ✗ failed to create provider "${name}": ${e.message}`);
    return null;
  }
  if (authMode === 'oauth-token') {
    log(c.gray('  ⓘ A Claude subscription login cannot be checked with a quick request — start a small task with this provider to confirm it works.'));
  } else if (await promptYesNo(rl, 'Test it now (a tiny request)?', true)) {
    try {
      const t = await apiPost(`/providers/${encodeURIComponent(name)}/test`);
      reportTest(t, authMode);
    } catch (e) {
      log(`  ✗ test failed: ${e.message}`);
    }
  }
  return name;
}

const providerLine = (p, def) =>
  `    ${c.cyan('•')} ${c.bold(p.name)} ${c.gray(`(${p.kind}, ${p.authMode}${p.model ? `, ${p.model}` : ''})`)}${p.name === def ? ` ${c.green('★ default')}` : ''}${!p.model ? c.yellow('  no model') : ''}`;

async function setDefaultProvider(name) {
  try {
    await apiPut('/settings', { defaultProvider: name });
    log(`  ✓ "${name}" is now the default provider`);
    return true;
  } catch (e) {
    log(`  ✗ ${e.message}`);
    return false;
  }
}

/** Edit: keep the current model, pick one from the provider's own list (or the known Claude models), or type a name. */
async function chooseModel(rl, p) {
  const how = await promptChoice(
    rl,
    `Default model${p.model ? ` (now ${p.model})` : ''}`,
    [
      { value: 'keep', label: 'Keep it', hint: p.model ? `— ${p.model}` : '— none set' },
      { value: 'list', label: 'Choose from the available models' },
      { value: 'type', label: 'Type a model name' },
    ],
    p.model ? 'keep' : 'list',
  );
  if (how === 'keep') return p.model || '';
  if (how === 'type') return (await prompt(rl, 'Model name', p.model || undefined)).trim();
  let models = [];
  try {
    const r = await apiGet(`/providers/${encodeURIComponent(p.name)}/models`);
    if (r.ok && r.models?.length) models = r.models.map((m) => ({ value: m, label: m }));
    else log(c.gray(`  (the provider could not list its models: ${r.error || 'none returned'})`));
  } catch (e) {
    log(c.gray(`  (could not list models: ${e.message})`));
  }
  if (!models.length && KNOWN_MODELS[p.kind]) {
    log(c.gray('  Showing the current models for this provider type instead:'));
    models = KNOWN_MODELS[p.kind].map((m) => ({ value: m.id, label: m.id, hint: m.hint }));
  }
  if (!models.length) return (await prompt(rl, 'Model name', p.model || undefined)).trim();
  const other = '\u0000other';
  const pick = await promptChoice(rl, 'Pick a model', [...models, { value: other, label: 'Another model…', hint: '— type its name' }], models.some((m) => m.value === p.model) ? p.model : models[0].value);
  return pick === other ? (await prompt(rl, 'Model name', p.model || undefined)).trim() : pick;
}

/** Change one provider: model, base URL, limits, secret / sign-in, and whether it is the default. */
async function editProvider(rl, p, def) {
  log(`  Editing "${p.name}" (${p.kind}, ${p.authMode}). Enter keeps the current value.`);
  const patch = {};
  const model = await chooseModel(rl, p);
  if (model && model !== p.model) patch.model = model;
  if (p.kind !== 'codex') {
    const baseUrl = await askUrl(rl, 'Base URL (- clears)', p.baseUrl, { allowClear: true });
    if (baseUrl === '-') patch.baseUrl = '';
    else if (baseUrl && baseUrl !== p.baseUrl) patch.baseUrl = baseUrl;
  }
  if (p.authMode === 'codex-login') {
    if (await promptYesNo(rl, 'Sign in to ChatGPT again (renew or switch the account)?', false)) await codexSignIn(rl);
  } else {
    const secret =
      p.authMode === 'oauth-token'
        ? (await promptYesNo(rl, 'Replace the Claude login token?', false))
          ? await claudeSignIn(rl)
          : ''
        : await promptSecret(rl, `New secret (blank = keep current${p.secretSet ? ` ${p.secretHint ?? ''}` : ', none set yet'}): `);
    if (secret) patch.secret = secret;
  }
  if (await promptYesNo(rl, 'Change the rate limits (rpm/tpm)?', false)) {
    const rpm = (await prompt(rl, 'Requests/min (0 = none)', p.rpm ? String(p.rpm) : undefined)).trim();
    const tpm = (await prompt(rl, 'Tokens/min (0 = none)', p.tpm ? String(p.tpm) : undefined)).trim();
    if (rpm !== '' && Number(rpm) !== (p.rpm ?? 0)) patch.rpm = Number(rpm) || 0;
    if (tpm !== '' && Number(tpm) !== (p.tpm ?? 0)) patch.tpm = Number(tpm) || 0;
  }
  if (Object.keys(patch).length) {
    try {
      await apiPut(`/providers/${encodeURIComponent(p.name)}`, patch);
      log(`  ✓ "${p.name}" updated (${Object.keys(patch).join(', ')})`);
    } catch (e) {
      log(`  ✗ failed to update "${p.name}": ${e.message}`);
    }
  } else {
    log('  (no change)');
  }
  if (p.name !== def && (await promptYesNo(rl, `Make "${p.name}" the default provider?`, false))) await setDefaultProvider(p.name);
}

async function deleteProvider(rl, p, def, others) {
  const isDefault = p.name === def;
  if (!(await promptYesNo(rl, `Delete "${p.name}"${isDefault ? ' — it is the DEFAULT provider' : ''}? Agents that use it will stop working until you pick another.`, false))) return;
  try {
    await api('DELETE', `/providers/${encodeURIComponent(p.name)}`);
    log(`  ✓ "${p.name}" deleted`);
  } catch (e) {
    log(`  ✗ failed to delete "${p.name}": ${e.message}`);
    return;
  }
  if (isDefault && others.length) {
    const next = await promptChoiceOptional(rl, 'Choose the new default provider', others.map((o) => o.name));
    if (next) await setDefaultProvider(next);
    else log('  ⚠ no default provider is set now — tasks without an agent will fail until you choose one.');
  }
}

/** Providers: list them (with the default marked), and add / edit / set default / test / delete in a loop. Returns the names. */
async function stepProviders(rl) {
  header('Step 1 — Providers (network, model, auth)');
  for (;;) {
    const list = await apiGet('/providers').catch(() => []);
    const settings = await apiGet('/settings').catch(() => ({}));
    const def = settings.defaultProvider;
    if (list.length) {
      log('  Providers now:');
      for (const p of list) log(providerLine(p, def));
      if (!list.some((p) => p.name === def)) log(c.yellow(`  ⚠ the default provider "${def ?? '(none)'}" does not exist — choose a default below.`));
    } else {
      log('  No providers yet.');
    }
    const choices = [
      { value: 'add', label: 'Add a provider' },
      ...(list.length
        ? [
            { value: 'edit', label: 'Edit a provider', hint: '— model, address, key / sign-in, limits' },
            { value: 'default', label: 'Set the default provider' },
            { value: 'test', label: 'Test a provider' },
            { value: 'delete', label: 'Delete a provider' },
          ]
        : []),
      { value: 'done', label: '← Back' },
    ];
    const what = await promptChoice(rl, 'Providers', choices, list.length ? 'edit' : 'add', { back: 'done' });
    if (what === 'done') return list.map((p) => p.name);
    try {
      if (what === 'add') {
        const created = await addProvider(rl, list.length === 0);
        if (created && (list.length === 0 || (await promptYesNo(rl, `Make "${created}" the default provider?`, false)))) await setDefaultProvider(created);
        continue;
      }
      const pick = async (q) => {
        if (list.length === 1) return list[0];
        const options = list.map((x) => ({ value: x.name, label: x.name, hint: `(${x.kind}, ${x.authMode}${x.model ? `, ${x.model}` : ''})${x.name === def ? ' ★ default' : ''}` }));
        const name = await promptChoice(rl, q, options, list.some((x) => x.name === def) ? def : list[0].name);
        return list.find((x) => x.name === name);
      };
      if (what === 'edit') await editProvider(rl, await pick('Which provider?'), def);
      else if (what === 'default') {
        const p = await pick('Which provider should be the default?');
        await setDefaultProvider(p.name);
      } else if (what === 'test') {
        const p = await pick('Test which provider?');
        try {
          const t = await apiPost(`/providers/${encodeURIComponent(p.name)}/test`);
          reportTest(t, p.authMode);
        } catch (e) {
          log(`  ✗ test failed: ${e.message}`);
        }
      } else if (what === 'delete') {
        const p = await pick('Delete which provider?');
        await deleteProvider(rl, p, def, list.filter((x) => x.name !== p.name));
      }
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
      log(c.gray('  (cancelled — back to the menu)'));
    }
  }
}

/**
 * One channel field. `current` (when editing) is shown as the default: Enter keeps it. Secrets never show their value — blank keeps
 * the stored one. A list is typed comma-separated; `-` clears it.
 */
async function promptChannelField(rl, field, current) {
  const editing = current !== undefined;
  const note = [field.required ? 'required' : null, field.help].filter(Boolean).join(' — ');
  const suffix = note ? ` (${note})` : '';
  if (field.type === 'password') {
    const hint = editing && current?.set ? ` [set ${current.hint ?? ''} — blank keeps]` : '';
    return await promptSecret(rl, `${field.label}${suffix}${hint}: `);
  }
  if (field.type === 'list') {
    const cur = Array.isArray(current) ? current.join(', ') : '';
    for (;;) {
      const answer = (await prompt(rl, `${field.label}${suffix} (comma-separated${editing ? ', Enter keeps, - clears' : ''})`, cur)).trim();
      if (answer === '-') return [];
      const list = splitCsv(answer);
      const bad = field.key === 'allowedChatIds' ? list.filter((x) => !/^-?\d+$/.test(x)) : [];
      if (!bad.length) return list;
      log(`  ✗ chat ids are numbers (e.g. 477581596, or -1001234567890 for a group) — not: ${bad.join(', ')}`);
    }
  }
  if (field.type === 'agent') {
    const agents = await apiGet('/agents').catch(() => []);
    if (!agents.length) return current || undefined;
    if (!editing) return await promptChoiceOptional(rl, `${field.label}${suffix}`, agents.map((a) => a.name));
    // editing: the current agent is preselected, so Enter keeps it; the first entry clears it
    const none = '\u0000none';
    const pick = await promptChoice(
      rl,
      `${field.label}${suffix}`,
      [
        { value: none, label: '(none — use the default lead)' },
        ...(current && !agents.some((a) => a.name === current) ? [{ value: current, label: current, hint: '(no such agent any more)' }] : []),
        ...agents.map((a) => a.name),
      ],
      current || none,
    );
    return pick === none ? '' : pick;
  }
  const value = await prompt(rl, `${field.label}${suffix}`, typeof current === 'string' ? current : undefined);
  return value || undefined;
}

/** Chats that wrote to the bot but are not allowed yet: offer to let each one in (this is how you add yourself without knowing your id). */
async function offerPendingChats(rl, row) {
  const pairings = await apiGet(`/channels/${row.id}/pairings`).catch(() => []);
  for (const p of pairings) {
    const who = [p.userName, p.firstText ? `"${p.firstText.slice(0, 40)}"` : null].filter(Boolean).join(' ');
    if (await promptYesNo(rl, `  Chat ${p.chatId}${who ? ` (${who})` : ''} wrote to the bot. Allow it?`, false)) {
      await apiPost(`/channels/${row.id}/pairings/${encodeURIComponent(p.chatId)}/allow`);
      log(`  ✓ chat ${p.chatId} allowed`);
    }
  }
  if (!pairings.length) log('  (no waiting chats — write anything to the bot from Telegram, then choose this again, or type your chat id)');
}

async function testChannel(rl, row) {
  if (!(await promptYesNo(rl, 'Test this channel now?', true))) return;
  const t = await apiPost(`/channels/${row.id}/test`);
  log(t.ok ? '  ✓ test ok' : `  ✗ test failed: ${t.error ?? 'unknown error'}`);
}

async function editChannel(rl, row, kindDef) {
  log(`  Editing "${row.name}" (${row.kind}). Enter keeps the current value.`);
  const config = {};
  for (const field of kindDef.fields) {
    const cur = field.type === 'password' ? row.secrets?.[field.key] : row.config?.[field.key];
    config[field.key] = await promptChannelField(rl, field, cur ?? (field.type === 'list' ? [] : ''));
  }
  const enabled = await promptYesNo(rl, 'Enabled?', row.enabled);
  try {
    const saved = await apiPut(`/channels/${row.id}`, { enabled, config });
    log(`  ✓ channel "${row.name}" updated`);
    await offerPendingChats(rl, saved);
    await testChannel(rl, saved);
  } catch (e) {
    log(`  ✗ failed to update "${row.name}": ${e.message}`);
  }
}

async function addChannel(rl, available) {
  const kindNames = available.map((k) => k.kind);
  const kind = await promptChoice(rl, 'Channel kind', kindNames, kindNames[0]);
  const kindDef = available.find((k) => k.kind === kind);
  if (kindDef.hint) log(`  ${kindDef.hint}`);
  const name = await prompt(rl, 'Channel name (id)', kind);
  const config = {};
  for (const field of kindDef.fields) {
    config[field.key] = await promptChannelField(rl, field);
  }
  try {
    const row = await apiPost('/channels', { name, kind, enabled: true, config });
    log(`  ✓ channel "${name}" created`);
    await offerPendingChats(rl, row);
    await testChannel(rl, row);
  } catch (e) {
    log(`  ✗ failed to create channel "${name}": ${e.message}`);
  }
}

async function stepChannels(rl) {
  header('Step 2 — Channels');
  const kinds = await apiGet('/channels/kinds').catch(() => []);
  const available = kinds.filter((k) => k.available);
  if (!available.length) {
    log('  No channel kind is implemented yet.');
    return;
  }
  for (;;) {
    const existing = await apiGet('/channels').catch(() => []);
    if (existing.length) {
      log('  Channels now:');
      for (const ch of existing) {
        const allowed = Array.isArray(ch.config?.allowedChatIds) ? ch.config.allowedChatIds.length : 0;
        log(`    ${c.cyan('•')} ${c.bold(ch.name)} ${c.gray(`(${ch.kind})`)} ${ch.enabled ? c.green('on') : c.red('OFF')}${allowed ? c.gray(`, ${allowed} allowed chat(s)`) : c.yellow(', no allowed chats yet')}`);
      }
    }
    const choices = [
      ...(existing.length ? [{ value: 'edit', label: 'Edit a channel', hint: '— allowed chats, token, on/off' }] : []),
      { value: 'add', label: 'Add a channel', hint: '— e.g. Telegram' },
      { value: 'done', label: '← Back' },
    ];
    const what = await promptChoice(rl, 'Channels', choices, existing.length ? 'edit' : 'add', { back: 'done' });
    if (what === 'done') return;
    try {
      if (what === 'add') {
        await addChannel(rl, available);
        continue;
      }
      const name =
        existing.length === 1
          ? existing[0].name
          : await promptChoice(rl, 'Which channel?', existing.map((ch) => ({ value: ch.name, label: ch.name, hint: `(${ch.kind}, ${ch.enabled ? 'on' : 'off'})` })), existing[0].name);
      const row = existing.find((c) => c.name === name);
      const kindDef = available.find((k) => k.kind === row.kind);
      if (!kindDef) log(`  ✗ kind "${row.kind}" is not available`);
      else await editChannel(rl, row, kindDef);
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
      log(c.gray('  (cancelled — back to the menu)'));
    }
  }
}

// ---- Access: where the server answers (domains, Cloudflare Access, address settings) ----

/** Set (or, with null, remove) KEY=value in an env file, replacing a commented-out example line if there is one. */
function setEnvVar(file, key, value) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const live = new RegExp(`^\\s*${key}=`);
  const example = new RegExp(`^\\s*#\\s*${key}=`);
  let at = lines.findIndex((l) => live.test(l));
  if (at < 0) at = lines.findIndex((l) => example.test(l));
  if (value === null) {
    if (at >= 0 && live.test(lines[at])) lines.splice(at, 1);
  } else if (at >= 0) {
    lines[at] = `${key}=${value}`;
  } else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${key}=${value}`, '');
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  renameSync(tmp, file);
}

async function putAccessDomains(list) {
  try {
    await apiPut('/access', { allowedHosts: list });
    log('  ✓ saved — takes effect immediately');
    return true;
  } catch (e) {
    log(`  ✗ ${e.message}`);
    return false;
  }
}

async function configureCloudflareAccess(rl) {
  const cf = await apiGet('/cloudflare-access').catch(() => null);
  if (!cf) {
    log('  ✗ could not read the Cloudflare Access settings from the server.');
    return;
  }
  log(c.gray('  Zero Trust → Settings → Team domain; Access → Applications → your app → Overview → Application Audience (AUD) Tag.'));
  const teamDomain = await prompt(rl, 'Team domain (yourteam.cloudflareaccess.com)', cf.teamDomain || undefined);
  const aud = await prompt(rl, `Application Audience (AUD) tag${cf.audSet ? ` — saved (${cf.audHint}), Enter keeps it` : ''}`);
  const enabled = await promptYesNo(rl, 'Require Cloudflare Access on public (domain-name) addresses?', cf.enabled || !cf.configured);
  try {
    await apiPut('/cloudflare-access', { enabled, teamDomain, aud: aud || undefined });
    log(`  ✓ saved${enabled ? ' — public addresses now need a Cloudflare Access sign-in' : ' (switched off)'}`);
  } catch (e) {
    log(`  ✗ ${e.message}`);
    return;
  }
  if (await promptYesNo(rl, 'Check the connection to Cloudflare now?', true)) {
    try {
      const t = await apiPost('/cloudflare-access/test');
      log(t.keys.ok ? `  ✓ Cloudflare's signing keys fetched (${t.keys.count})` : `  ✗ could not fetch Cloudflare's keys: ${t.keys.error}`);
      log(c.gray('  (This terminal request does not go through Cloudflare, so it carries no Access sign-in — that is expected.)'));
    } catch (e) {
      log(`  ✗ ${e.message}`);
    }
  }
}

/** PUBLIC_URL / ORCHESTRATOR_HOST live in the server's .env: editable here only when the wizard can reach that file. */
async function configureServerAddress(rl, server) {
  const envFile = process.env.AIGENTRON_ENV_FILE;
  const writable = (() => {
    try {
      if (!envFile) return false;
      accessSync(envFile, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();
  log(`  Now: public address ${server.publicUrl ?? '(not set)'}, listens on ${server.listenHost}:${server.port}${server.bindAddress ? `, published on ${server.bindAddress}` : ''}.`);
  if (!writable) {
    log('  These two settings live in the server\'s .env file, which this terminal cannot edit (e.g. a Docker install: the file is on the host).');
    log('  Add the lines to .env and restart:');
    log('    PUBLIC_URL=https://dev.example.com        # your public address (added to the allowed domains automatically)');
    log('    ORCHESTRATOR_HOST=127.0.0.1               # listen on this machine only (e.g. behind a tunnel); default 0.0.0.0');
    log(c.gray('  Docker install: re-run the installer (aigentron update) so the container picks the new .env up.'));
    return;
  }
  const urlIn = (await prompt(rl, 'Public address (https://…, - removes it, Enter keeps)', server.publicUrl || undefined)).trim();
  let changed = false;
  if (urlIn === '-') {
    setEnvVar(envFile, 'PUBLIC_URL', null);
    changed = true;
  } else if (urlIn && urlIn !== server.publicUrl) {
    try {
      const u = new URL(urlIn);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error('bad');
      setEnvVar(envFile, 'PUBLIC_URL', u.origin);
      changed = true;
    } catch {
      log('  ✗ that is not a valid http(s) address');
    }
  }
  const host = await promptChoice(
    rl,
    'Listen on',
    [
      { value: '0.0.0.0', label: 'All interfaces', hint: '— reachable from the network (default)' },
      { value: '127.0.0.1', label: 'This machine only', hint: '— e.g. behind a Cloudflare tunnel or reverse proxy' },
    ],
    server.listenHost === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
  );
  if (host !== server.listenHost) {
    if (host === '127.0.0.1') setEnvVar(envFile, 'ORCHESTRATOR_HOST', host);
    else setEnvVar(envFile, 'ORCHESTRATOR_HOST', null);
    changed = true;
  }
  if (changed) {
    log(`  ✓ ${envFile} updated`);
    log('  ⚠ These take effect after a restart:  sudo aigentron restart');
    if (host === '127.0.0.1') log(c.yellow('  ⚠ Listening on this machine only: open the dashboard through the tunnel / proxy or an SSH forward, not by the server\'s IP.'));
  } else {
    log('  (no change)');
  }
}

async function stepAccess(rl) {
  header('Access — where the server answers');
  for (;;) {
    const acc = await apiGet('/access').catch(() => null);
    if (!acc) {
      log('  ✗ could not read the access settings from the server.');
      return;
    }
    const cf = await apiGet('/cloudflare-access').catch(() => ({}));
    log(`  You are connected via ${c.bold(acc.yourHost || 'unknown')}.`);
    log(
      acc.allowedHosts.length
        ? `  Allowed domains (${acc.enforced ? 'enforced' : 'not enforced'}): ${acc.allowedHosts.map((d) => c.cyan(d)).join(', ')}`
        : `  Allowed domains: ${c.gray('none — any name is accepted')}`,
    );
    if (acc.publicHost) log(`  Public address (PUBLIC_URL): ${c.cyan(acc.publicHost)} ${c.gray('— always allowed')}`);
    log(`  Cloudflare Access: ${cf.enabled ? c.green(`on (${cf.teamDomain})`) : cf.configured ? c.yellow(`saved but off (${cf.teamDomain})`) : c.gray('not set up')}`);
    log(c.gray('  localhost, IP addresses and single-word names are always allowed, so you cannot lock yourself out.'));
    const choices = [
      { value: 'add', label: 'Add domains', hint: '— e.g. dev.example.com, *.team.example.org' },
      ...(acc.allowedHosts.length ? [{ value: 'remove', label: 'Remove a domain' }, { value: 'clear', label: 'Clear the list', hint: '— accept any name again' }] : []),
      { value: 'cloudflare', label: 'Cloudflare Access', hint: '— require its sign-in on public addresses' },
      { value: 'server', label: 'Public address & listening', hint: '— PUBLIC_URL, listen on this machine only' },
      { value: 'done', label: '← Back' },
    ];
    const what = await promptChoice(rl, 'Access', choices, 'add', { back: 'done' });
    if (what === 'done') return;
    try {
      if (what === 'add') {
        const input = await prompt(rl, 'Domains to add (comma-separated)');
        const add = splitCsv(input);
        if (add.length) await putAccessDomains([...new Set([...acc.allowedHosts, ...add])]);
      } else if (what === 'remove') {
        const d = await promptChoice(rl, 'Remove which domain?', acc.allowedHosts, acc.allowedHosts[0]);
        await putAccessDomains(acc.allowedHosts.filter((x) => x !== d));
      } else if (what === 'clear') {
        if (await promptYesNo(rl, 'Clear the whole list?', false)) await putAccessDomains([]);
      } else if (what === 'cloudflare') {
        await configureCloudflareAccess(rl);
      } else if (what === 'server') {
        await configureServerAddress(rl, acc.server ?? { port: 3001, listenHost: '0.0.0.0', bindAddress: null, publicUrl: null });
      }
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
      log(c.gray('  (cancelled — back to the menu)'));
    }
  }
}

async function stepAgents(rl, providerNames) {
  header('Step 3 — Agents (+ skills)');
  const agents = await apiGet('/agents').catch(() => []);
  if (!agents.length) {
    log('  No agents found — nothing to configure.');
    return;
  }
  const allSkills = await apiGet('/agents/skills').catch(() => []);
  log(`  Agents: ${agents.map((a) => a.name).join(', ')}`);
  if (allSkills.length) {
    log(`  Skills available to all agents by default: ${allSkills.join(', ')}`);
    // The only two core skills that actually call an mcp__ tool (everything
    // else is pure Bash/knowledge, no MCP dependency) — neither's MCP server
    // is set up by default outside the full dev-stack profile: code-intel
    // needs `uv`/`uvx` (Serena), playwright needs a running browser MCP
    // service. An agent assigned one without it fails at task-run time, not
    // here at setup time, so flag it now instead.
    const mcpSkills = allSkills.filter((s) => s === 'code-intel' || s === 'playwright');
    if (mcpSkills.length) {
      log(`  Note: ${mcpSkills.join(', ')} need${mcpSkills.length === 1 ? 's' : ''} an MCP server not set up by`);
      log('  default on bare-metal/minimal installs (code-intel: `uv`/`uvx`; playwright: a running browser MCP');
      log('  service) — only assign these to an agent if you\'ve set that up, or it\'ll fail at run time.');
    }
  }

  while (await promptYesNo(rl, 'Configure an agent now?', true)) {
    const name = await promptChoice(rl, 'Which agent?', agents.map((a) => a.name), agents[0].name);
    const def = await apiGet(`/agents/${encodeURIComponent(name)}`);

    const provider = providerNames.length
      ? (await promptChoiceOptional(rl, `Provider for "${name}" (blank = keep "${def.provider || 'platform default'}")`, providerNames)) ||
        def.provider
      : def.provider;

    const modelInput = await prompt(rl, `Model override for "${name}" (blank = keep "${def.model || 'provider default'}")`);
    const model = modelInput || def.model;

    let fallbackProviders = def.fallbackProviders;
    if (providerNames.length > 1 && (await promptYesNo(rl, 'Set fallback providers (in order)?', false))) {
      fallbackProviders = splitCsv(await prompt(rl, `Fallback providers, comma-separated (from: ${providerNames.join(', ')})`));
    }

    let skills = def.skills;
    if (allSkills.length && (await promptYesNo(rl, `Restrict "${name}" to a subset of skills? (default: all)`, false))) {
      skills = splitCsv(await prompt(rl, `Skills for "${name}", comma-separated (from: ${allSkills.join(', ')})`));
    }

    try {
      await apiPut(`/agents/${encodeURIComponent(name)}`, {
        description: def.description,
        provider: provider || undefined,
        model: model || undefined,
        fallbackProviders: toCsvOrUndef(fallbackProviders),
        skills: toCsvOrUndef(skills),
        allowedTools: toCsvOrUndef(def.allowedTools),
        disallowedTools: toCsvOrUndef(def.disallowedTools),
        mcp: toCsvOrUndef(def.mcp),
        instructions: def.instructions,
      });
      log(`  ✓ agent "${name}" updated`);
    } catch (e) {
      log(`  ✗ failed to update "${name}": ${e.message}`);
    }
  }

  if (await promptYesNo(rl, "Set a default agent (used when a task doesn't pick one)?", false)) {
    const name = await promptChoice(rl, 'Default agent', agents.map((a) => a.name), agents[0].name);
    try {
      await apiPut('/settings', { defaultAgent: name });
      log(`  ✓ default agent set to "${name}"`);
    } catch (e) {
      log(`  ✗ ${e.message}`);
    }
  }
}

async function stepRepo(rl) {
  header('Step 4 — Repository (optional)');
  if (!(await promptYesNo(rl, 'Configure a project repository now?', false))) {
    log('  Skipped — configurable later in Settings.');
    return;
  }
  const repoUrl = await prompt(rl, 'Repo URL (blank = local-only, no remote)');
  const repoBranch = await prompt(rl, 'Base branch', 'main');
  const githubToken = repoUrl ? await promptSecret(rl, 'GitHub token (for push/PR, blank = none): ') : '';
  const workspaceSubdir = await prompt(rl, 'Subdirectory within the repo agents should work in (blank = repo root)');
  try {
    await apiPut('/settings', {
      repoUrl: repoUrl || undefined,
      repoBranch: repoBranch || undefined,
      githubToken: githubToken || undefined,
      workspaceSubdir: workspaceSubdir || undefined,
    });
    log('  ✓ repository settings saved');
  } catch (e) {
    log(`  ✗ failed: ${e.message}`);
  }
}

async function stepAdvanced(rl, { startUnlocked = false } = {}) {
  header('Advanced mode (password-gated)');
  if (!startUnlocked && !(await promptYesNo(rl, 'Enter advanced mode?', false))) return;

  const password = await promptSecret(rl, 'Admin password: ');
  let verify;
  try {
    verify = await apiPost('/settings/verify-wizard-password', { password });
  } catch (e) {
    log(`  ✗ could not verify: ${e.message}`);
    return;
  }
  if (!verify.ok) {
    if (verify.error) {
      log(`  ✗ ${verify.error}`);
      log('  Pick your own WIZARD_ADMIN_PASSWORD in your .env (a short memorable one — you\'ll type it');
      log('  back in later, e.g. over Telegram or the dashboard) and restart the service.');
    } else {
      log('  ✗ wrong password');
    }
    return;
  }

  log('  ✓ unlocked. Blank keeps the current value.');
  const current = await apiGet('/settings');
  const patch = {};
  const approvalTimeoutSeconds = toIntOrUndef(await prompt(rl, `Approval timeout seconds [${current.approvalTimeoutSeconds}]`));
  if (approvalTimeoutSeconds !== undefined) patch.approvalTimeoutSeconds = approvalTimeoutSeconds;
  const verifyMaxAttempts = toIntOrUndef(await prompt(rl, `Verify max attempts [${current.verifyMaxAttempts}]`));
  if (verifyMaxAttempts !== undefined) patch.verifyMaxAttempts = verifyMaxAttempts;
  const verifyCommands = await prompt(rl, `Verify commands, one per line joined by ';' [${current.verifyCommands || '(none)'}]`);
  if (verifyCommands) patch.verifyCommands = verifyCommands;
  const debugModeRaw = await prompt(rl, `Debug mode? (y/n) [${current.debugMode ? 'y' : 'n'}]`);
  if (debugModeRaw) patch.debugMode = /^y/i.test(debugModeRaw);
  const agentInstructions = await prompt(rl, 'Extra global agent instructions to append (blank = keep current)');
  if (agentInstructions) patch.agentInstructions = agentInstructions;

  if (Object.keys(patch).length) {
    await apiPut('/settings', patch);
    log('  ✓ advanced settings updated');
  } else {
    log('  (no changes)');
  }
}

function parseArgs(argv) {
  const args = { advanced: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--orchestrator-url') args.orchestratorUrl = argv[++i];
    else if (a === '--advanced') args.advanced = true;
    else if (a === '--section') args.section = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function printHelp() {
  log('Usage: node infra/setup-wizard.mjs [--orchestrator-url <url>] [--advanced]');
  log('  --orchestrator-url  Orchestrator base URL (default: remembered from the first run, else http://localhost:3001)');
  log('  --advanced          Skip straight to the password-gated advanced-settings step');
  log('  --section <name>    Jump straight to one section: providers | channels | agents | repo | access | advanced | connection');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  // No `output`: with one, readline runs in terminal mode on a TTY and echoes
  // every keypress itself. readRawLine()'s stdin.resume() re-activates that
  // listener, so each typed/pasted character was printed twice (ours + its).
  // Without `output` it is non-terminal and never writes to the screen.
  const rl = createInterface({ input: process.stdin });
  // Paused immediately and never used to actually read input — every prompt
  // (qp()/promptSecret(), see readRawLine()) reads stdin itself in raw mode.
  // Kept alive only for this SIGINT fallback and rl.close() at the end; if
  // it stayed active it would compete with readRawLine() for stdin bytes,
  // which is exactly the race that used to leak pasted secrets in cleartext.
  rl.pause();
  rl.on('SIGINT', () => {
    log('\naborted');
    process.exit(130);
  });

  try {
    banner('Aigentron setup wizard', 'Esc goes back / cancels · Ctrl+C quits · re-run any time');
    await stepConnection(rl, args.orchestratorUrl, { force: args.section === 'connection' });
    await ensureSignedIn(rl);

    if (args.section) {
      const names = async () => (await apiGet('/providers').catch(() => [])).map((p) => p.name);
      const sections = {
        providers: () => stepProviders(rl),
        channels: () => stepChannels(rl),
        agents: async () => stepAgents(rl, await names()),
        repo: () => stepRepo(rl),
        access: () => stepAccess(rl),
        connection: async () => undefined, // already handled above (forced)
        advanced: () => stepAdvanced(rl, { startUnlocked: false }),
      };
      if (!sections[args.section]) throw new Error(`unknown section "${args.section}" — use: ${Object.keys(sections).join(', ')}`);
      await sections[args.section]();
      return;
    }

    if (args.advanced) {
      await stepAdvanced(rl, { startUnlocked: true });
      return;
    }

    const providerNames = async () => (await apiGet('/providers').catch(() => [])).map((p) => p.name);
    let first = (await providerNames()).length === 0;
    let guided = false;
    for (;;) {
      const what = await select(
        'What would you like to do?',
        [
          { value: 'all', label: 'Guided setup', hint: '— providers → channels → agents → repo, step by step' },
          { value: 'providers', label: 'Providers', hint: '— model, base URL, secrets' },
          { value: 'channels', label: 'Channels', hint: '— Telegram etc., allowed chats' },
          { value: 'agents', label: 'Agents' },
          { value: 'repo', label: 'Repository' },
          { value: 'access', label: 'Access', hint: '— domains, Cloudflare Access, public address' },
          { value: 'advanced', label: 'Advanced settings', hint: '— password-gated' },
          { value: 'connection', label: 'Connection', hint: '— how this wizard reaches the server' },
          { value: 'quit', label: 'Exit' },
        ],
        first ? 'all' : 'channels',
        { back: 'quit' },
      );
      first = false;
      if (what === 'quit') break;
      try {
        if (what === 'all') {
          const providers = await stepProviders(rl);
          await stepChannels(rl);
          await stepAgents(rl, providers);
          await stepRepo(rl);
          await stepAdvanced(rl);
          guided = true;
          break;
        }
        if (what === 'providers') await stepProviders(rl);
        else if (what === 'channels') await stepChannels(rl);
        else if (what === 'agents') await stepAgents(rl, await providerNames());
        else if (what === 'repo') await stepRepo(rl);
        else if (what === 'access') await stepAccess(rl);
        else if (what === 'advanced') await stepAdvanced(rl, { startUnlocked: false });
        else if (what === 'connection') await stepConnection(rl, undefined, { force: true });
      } catch (e) {
        if (!(e instanceof Cancelled)) throw e;
        log(c.gray('  (cancelled — back to the main menu)'));
      }
    }

    if (guided) {
      header('Done');
      log(`Orchestrator: ${BASE}/api/health`);
      log('Dashboard: check DASHBOARD_BASE_URL in your .env (default http://localhost:3000)');
      log(c.gray('Re-run this wizard any time: node infra/setup-wizard.mjs'));
    }
  } finally {
    rl.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
  if (e instanceof Cancelled) {
    console.log(c.gray('\ncancelled'));
    process.exit(0);
  }
  console.error(`\nfatal: ${e.message}`);
  process.exit(1);
});
