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
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
function readKeys(onKey) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk) => {
      for (const raw of chunk.toString('utf8').match(KEY_RE) ?? []) {
        const name = ESC_NAMES[raw] ?? (raw === '\r' || raw === '\n' ? 'enter' : raw === '\u0003' ? 'ctrl-c' : raw === '\u007f' || raw === '\b' ? 'backspace' : raw === '\t' ? 'tab' : raw === '\u001b' ? 'esc' : raw);
        if (name === 'ctrl-c') {
          stdin.removeListener('data', onData);
          process.stdout.write('\u001b[?25h');
          log(`\n${c.red('aborted')}`);
          process.exit(130);
        }
        if (onKey(name, raw)) {
          stdin.removeListener('data', onData);
          // Stop reading between prompts, or the open stdin keeps the process alive after the last step ("hangs on Done").
          // Raw mode stays on, so keys typed in the gap are still not echoed.
          stdin.pause();
          resolve();
          return;
        }
      }
    };
    stdin.on('data', onData);
  });
}

function readRawLine(query, { mask = false } = {}) {
  return new Promise((resolve) => {
    process.stdout.write(query);
    let buf = '';
    void readKeys((name, raw) => {
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
async function select(query, options, def) {
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
  process.stdout.write(`${qMark()} ${c.bold(query)} ${c.gray('(↑/↓, Enter)')}\n\u001b[?25l`);
  render(true);
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
  // collapse the menu to one line with the answer
  process.stdout.write(`\u001b[${items.length + 1}A\u001b[J${tick()} ${c.bold(query)} ${c.cyan(items[idx].label)}\n\u001b[?25h`);
  return items[idx].value;
}

/** Yes/No: ←/→ or y/n toggles, Enter confirms (the default is preselected). */
async function confirm(query, def = false) {
  if (!INTERACTIVE) {
    const a = (await readRawLine(`${query} (${def ? 'Y/n' : 'y/N'}): `)).trim().toLowerCase();
    return a ? /^y(es)?$/.test(a) : def;
  }
  let yes = def;
  const draw = () => process.stdout.write(`\r\u001b[2K${qMark()} ${c.bold(query)}  ${yes ? c.green(c.bold('● Yes')) : c.gray('○ Yes')}  ${yes ? c.gray('○ No') : c.red(c.bold('● No'))}  ${c.gray('(←/→, y/n, Enter)')}`);
  process.stdout.write('\u001b[?25l');
  draw();
  await readKeys((name) => {
    if (name === 'left' || name === 'right' || name === 'tab' || name === 'h' || name === 'l') yes = !yes;
    else if (name === 'y' || name === 'Y') yes = true;
    else if (name === 'n' || name === 'N') yes = false;
    else if (name === 'enter') return true;
    draw();
    return false;
  });
  process.stdout.write(`\r\u001b[2K${tick()} ${c.bold(query)} ${yes ? c.green('Yes') : c.red('No')}\n\u001b[?25h`);
  return yes;
}

const promptYesNo = (_rl, query, def = false) => confirm(query, def);
const promptChoice = (_rl, query, options, def) => select(query, options, def ?? (typeof options[0] === 'string' ? options[0] : options[0].value));

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
  return promptSecret(rl, `${label}: `);
}

// ---- steps ----

async function stepDeploymentMode(rl, cliUrl) {
  header('Step 0 — Deployment');
  const mode = await promptChoice(
    rl,
    'How is Aigentron installed here?',
    [
      { value: 'docker', label: 'Docker', hint: '— the container install' },
      { value: 'bare-metal', label: 'Bare-metal', hint: '— a systemd service on this machine' },
      { value: 'not-sure', label: 'Not sure' },
    ],
    'not-sure',
  );
  const defaultUrl = cliUrl || process.env.ORCHESTRATOR_URL || 'http://localhost:3001';
  BASE = (await prompt(rl, 'Orchestrator URL', defaultUrl)).replace(/\/$/, '');
  try {
    const health = await waitForOrchestrator();
    log(`  ✓ reachable (version ${health.version ?? 'unknown'})`);
  } catch {
    log(`  ✗ could not reach ${BASE}/api/health.`);
    if (mode === 'docker') {
      log('  If Node isn\'t installed on this machine, run this wizard via:');
      log('    docker exec -it <container-name> node /app/infra/setup-wizard.mjs');
    }
    throw new Error('orchestrator unreachable — fix the URL/deployment and re-run');
  }
  return mode;
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
async function stepRotateExistingSecret(rl) {
  let existing;
  try {
    existing = await apiGet('/providers');
  } catch {
    return [];
  }
  if (!existing.length) return [];
  const names = existing.map((p) => p.name);
  if (!(await promptYesNo(rl, `Edit an existing provider — model, base URL or secret (found: ${names.join(', ')})?`, false))) {
    return names;
  }
  let more = true;
  while (more) {
    const name = await promptChoice(
      rl,
      'Which provider?',
      existing.map((x) => ({ value: x.name, label: x.name, hint: `(${x.kind}, ${x.authMode}${x.model ? `, ${x.model}` : ''})` })),
      names[0],
    );
    const p = existing.find((x) => x.name === name);
    const patch = {};
    const model = (await prompt(rl, 'Default model (Enter keeps)', p.model || undefined)).trim();
    if (model && model !== p.model) patch.model = model;
    if (p.kind !== 'codex') {
      const baseUrl = (await prompt(rl, 'Base URL (Enter keeps, - clears)', p.baseUrl || undefined)).trim();
      if (baseUrl === '-') patch.baseUrl = '';
      else if (baseUrl && baseUrl !== p.baseUrl) patch.baseUrl = baseUrl;
    }
    if (p.authMode === 'codex-login') {
      if (await promptYesNo(rl, 'Sign in to ChatGPT again (renew or switch the account)?', false)) await codexSignIn(rl);
    } else {
      const secret =
        p.authMode === 'oauth-token'
          ? await promptOauthSecret(rl, 'New OAuth token')
          : await promptSecret(rl, `New secret (blank = keep current${p.secretSet ? ` ${p.secretHint ?? ''}` : ', none set yet'}): `);
      if (secret) patch.secret = secret;
    }
    if (Object.keys(patch).length) {
      try {
        await apiPut(`/providers/${encodeURIComponent(name)}`, patch);
        log(`  ✓ "${name}" updated (${Object.keys(patch).join(', ')})`);
      } catch (e) {
        log(`  ✗ failed to update "${name}": ${e.message}`);
      }
    } else {
      log('  (no change)');
    }
    more = await promptYesNo(rl, 'Edit another provider?', false);
  }
  return names;
}

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
  mkdirSync(info.home, { recursive: true, mode: 0o700 });
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

const AUTH_METHODS = [
  { value: 'api-key', label: 'API key', hint: '— pay per use (Anthropic, OpenAI, DeepSeek, any compatible endpoint)' },
  { value: 'claude-login', label: 'Claude subscription', hint: '— sign in with Claude Pro/Max (claude setup-token)' },
  { value: 'codex-login', label: 'ChatGPT subscription (Codex)', hint: '— sign in with your ChatGPT plan (device code)' },
  { value: 'codex-key', label: 'OpenAI API key for Codex', hint: '— the Codex runtime, billed per use' },
  { value: 'auth-token', label: 'Bearer token', hint: '— for gateways that want Authorization: Bearer …' },
  { value: 'none', label: 'No authentication', hint: '— a local server such as Ollama' },
];

/** One provider, in the order: name → how it signs in → protocol / address → model → limits → save → test. Returns its name or null. */
async function addProvider(rl, firstOne) {
  const name = await prompt(rl, 'Provider name', firstOne ? 'claude-cloud' : undefined);
  if (!name) return null;
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
    secret = await promptSecret(rl, 'OpenAI API key (hidden): ');
  } else {
    // Base URL first, then suggest the protocol from it (a vendor's URL usually tells which one it speaks).
    const baseUrlInput = await prompt(rl, 'Base URL (blank = the vendor\'s native Anthropic API)');
    baseUrl = baseUrlInput || undefined;
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
      secret = await promptSecret(rl, 'Bearer token (hidden): ');
    } else {
      authMode = 'api-key';
      secret = await promptSecret(rl, 'API key (hidden): ');
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
  if (await promptYesNo(rl, 'Test it now (a tiny request)?', true)) {
    try {
      const t = await apiPost(`/providers/${encodeURIComponent(name)}/test`);
      log(t.ok ? `  ✓ works${t.latencyMs ? ` (${t.latencyMs} ms)` : ''}` : `  ✗ test failed: ${t.error ?? 'unknown error'}`);
    } catch (e) {
      log(`  ✗ test failed: ${e.message}`);
    }
  }
  return name;
}

async function stepProviders(rl) {
  header('Step 1 — Providers (network, model, auth)');
  const providers = await stepRotateExistingSecret(rl);
  let first = providers.length === 0;
  while (await promptYesNo(rl, first ? 'Add a provider now?' : 'Add another provider?', first)) {
    first = false;
    const created = await addProvider(rl, providers.length === 0);
    if (created) providers.push(created);
  }

  if (providers.length) {
    const def = await promptChoiceOptional(rl, 'Set the default provider', providers);
    if (def) {
      try {
        await apiPut('/settings', { defaultProvider: def });
        log(`  ✓ default provider set to "${def}"`);
      } catch (e) {
        log(`  ✗ ${e.message}`);
      }
    }
  }
  return providers;
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
    const answer = (await prompt(rl, `${field.label}${suffix} (comma-separated${editing ? ', Enter keeps, - clears' : ''})`, cur)).trim();
    if (answer === '-') return [];
    return splitCsv(answer);
  }
  if (field.type === 'agent') {
    const agents = await apiGet('/agents').catch(() => []);
    if (!agents.length) return current || undefined;
    const answer = await promptChoiceOptional(rl, `${field.label}${suffix}${current ? ` [now: ${current}]` : ''}`, agents.map((a) => a.name));
    return answer ?? (current || undefined);
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
      { value: 'done', label: 'Done with channels' },
    ];
    const what = await promptChoice(rl, 'Channels', choices, existing.length ? 'edit' : 'add');
    if (what === 'done') return;
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
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function printHelp() {
  log('Usage: node infra/setup-wizard.mjs [--orchestrator-url <url>] [--advanced]');
  log('  --orchestrator-url  Orchestrator base URL (default http://localhost:3001)');
  log('  --advanced          Skip straight to the password-gated advanced-settings step');
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
    banner('Aigentron setup wizard', 'guided configuration — re-run any time to change things');
    await stepDeploymentMode(rl, args.orchestratorUrl);

    if (args.advanced) {
      await stepAdvanced(rl, { startUnlocked: true });
      return;
    }

    const providerNames = async () => (await apiGet('/providers').catch(() => [])).map((p) => p.name);
    let first = (await providerNames()).length === 0;
    for (;;) {
      const what = await select(
        'What would you like to do?',
        [
          { value: 'all', label: 'Guided setup', hint: '— providers → channels → agents → repo, step by step' },
          { value: 'providers', label: 'Providers', hint: '— model, base URL, secrets' },
          { value: 'channels', label: 'Channels', hint: '— Telegram etc., allowed chats' },
          { value: 'agents', label: 'Agents' },
          { value: 'repo', label: 'Repository' },
          { value: 'advanced', label: 'Advanced settings', hint: '— password-gated' },
          { value: 'quit', label: 'Quit' },
        ],
        first ? 'all' : 'channels',
      );
      first = false;
      if (what === 'quit') break;
      if (what === 'all') {
        const providers = await stepProviders(rl);
        await stepChannels(rl);
        await stepAgents(rl, providers);
        await stepRepo(rl);
        await stepAdvanced(rl);
        break;
      }
      if (what === 'providers') await stepProviders(rl);
      else if (what === 'channels') await stepChannels(rl);
      else if (what === 'agents') await stepAgents(rl, await providerNames());
      else if (what === 'repo') await stepRepo(rl);
      else if (what === 'advanced') await stepAdvanced(rl, { startUnlocked: false });
    }

    header('Done');
    log(`Orchestrator: ${BASE}/api/health`);
    log('Dashboard: check DASHBOARD_BASE_URL in your .env (default http://localhost:3000)');
    log(c.gray('Re-run this wizard any time: node infra/setup-wizard.mjs'));
  } finally {
    rl.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
  console.error(`\nfatal: ${e.message}`);
  process.exit(1);
});
