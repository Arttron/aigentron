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

let BASE = 'http://localhost:3001';

function log(msg = '') {
  console.log(msg);
}
function header(title) {
  console.log(`\n== ${title} ==`);
}

// ---- prompt helpers (plain node:readline, one shared Interface) ----

function qp(rl, query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function prompt(rl, query, def) {
  const suffix = def !== undefined && def !== '' ? ` [${def}]` : '';
  const answer = (await qp(rl, `${query}${suffix}: `)).trim();
  return answer || def || '';
}

async function promptYesNo(rl, query, def = false) {
  const hint = def ? 'Y/n' : 'y/N';
  const answer = (await qp(rl, `${query} (${hint}): `)).trim().toLowerCase();
  if (!answer) return def;
  return /^y(es)?$/.test(answer);
}

/** Restrict to a fixed set of options; blank falls back to `def`, invalid re-prompts. */
async function promptChoice(rl, query, options, def) {
  for (;;) {
    const answer = (await qp(rl, `${query} [${options.join('/')}]${def ? ` (${def})` : ''}: `)).trim();
    if (!answer) return def ?? options[0];
    const match = options.find((o) => o.toLowerCase() === answer.toLowerCase());
    if (match) return match;
    log(`  please choose one of: ${options.join(', ')}`);
  }
}

/** Same as promptChoice, but blank means "none" instead of a required default. */
async function promptChoiceOptional(rl, query, options) {
  if (!options.length) return undefined;
  for (;;) {
    const answer = (await qp(rl, `${query} [${options.join('/')}] (blank = none): `)).trim();
    if (!answer) return undefined;
    const match = options.find((o) => o.toLowerCase() === answer.toLowerCase());
    if (match) return match;
    log(`  please choose one of: ${options.join(', ')}, or leave blank`);
  }
}

/** Masked input: readline still drives the actual line-editing (Enter/Backspace/
 *  Ctrl+C all work normally); a parallel raw 'data' listener just repaints the
 *  visible line as asterisks instead of echoing real characters. */
/**
 * Masked input, WITHOUT going through readline's own `.question()` — an
 * earlier version did (`rl.question('', cb)` + a manual 'data' listener that
 * redrew the label + asterisks on every keystroke), but readline's internal
 * line-refresh runs even with an empty prompt string, wiping the manually
 * -written label right after it's first printed; it then only reappears once
 * the first keystroke triggers our own redraw. Found live: the label visibly
 * "not appearing until you start typing" — a real, reproducible bug, not a
 * terminal quirk (confirmed in this codebase's own earlier test transcripts,
 * which show a literal stray `[K` escape-sequence remnant on screen).
 *
 * This does raw single-character accumulation instead (the standard
 * password-prompt pattern), pausing the shared `rl` (so it isn't also
 * consuming the same stdin bytes) and switching stdin to raw mode for the
 * duration — echoing '*' per character ourselves, with proper
 * backspace/Ctrl+C handling, then handing stdin back to `rl` afterward.
 */
function promptSecret(rl, query) {
  return new Promise((resolve) => {
    process.stdout.write(query);
    rl.pause();
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
      rl.resume();
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf.trim());
          return;
        } else if (ch === '\u0003') {
          // Ctrl+C — match readline's own SIGINT-on-prompt behavior.
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch === '\u007f' || ch === '\b') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          buf += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
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

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
  const res = spawnSync('claude', ['setup-token'], { stdio: 'inherit' });
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
  const mode = await promptChoice(rl, 'How is Aigentron installed here?', ['docker', 'bare-metal', 'not-sure'], 'not-sure');
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
  if (!(await promptYesNo(rl, `Rotate/update an existing provider's secret (found: ${names.join(', ')})?`, false))) {
    return names;
  }
  let more = true;
  while (more) {
    const name = await promptChoice(rl, 'Which provider?', names, names[0]);
    const p = existing.find((x) => x.name === name);
    const secret =
      p.authMode === 'oauth-token'
        ? await promptOauthSecret(rl, 'New OAuth token')
        : await promptSecret(rl, 'New secret (blank = keep current): ');
    if (secret) {
      try {
        await apiPut(`/providers/${encodeURIComponent(name)}`, { secret });
        log(`  ✓ "${name}" secret updated`);
      } catch (e) {
        log(`  ✗ failed to update "${name}": ${e.message}`);
      }
    } else {
      log('  (no change)');
    }
    more = await promptYesNo(rl, 'Rotate another provider\'s secret?', false);
  }
  return names;
}

async function stepProviders(rl) {
  header('Step 1 — Providers (network, model, auth)');
  const providers = await stepRotateExistingSecret(rl);
  let first = providers.length === 0;
  while (await promptYesNo(rl, first ? 'Add a provider now?' : 'Add another provider?', first)) {
    first = false;
    const name = await prompt(rl, 'Provider name (id)', providers.length ? undefined : 'claude-cloud');
    // Base URL BEFORE kind, then suggest kind from it (mirrors the
    // dashboard's ProviderForm.tsx) — asking kind first (with 'anthropic'
    // always the default) let an operator pair a non-native base URL with
    // the wrong kind (e.g. leaving kind=anthropic against a vendor whose
    // native endpoint doesn't speak Anthropic protocol) without any signal
    // something might be off. `kind` isn't just a label: it's what tells
    // LiteLLM which protocol to speak upstream (or, for kind=anthropic, that
    // no translation is needed at all — some vendors, e.g. DeepSeek, expose
    // a genuine Anthropic-compatible path of their own, not just an OpenAI
    // one; guessKind() below recognizes a `.../anthropic` URL for exactly
    // that case).
    const baseUrlInput = await prompt(rl, 'Base URL (blank = native Anthropic API)');
    const baseUrl = baseUrlInput || undefined;
    const suggestedKind = guessKind(baseUrl);
    const kind = await promptChoice(rl, 'Kind (upstream family — LiteLLM uses this to know the protocol to speak)', ['anthropic', 'openai', 'deepseek', 'ollama'], suggestedKind);
    if (baseUrl && kind !== suggestedKind) {
      log(`  Note: "${baseUrl}" looked like a ${suggestedKind} endpoint to us — make sure ${kind} is really what it speaks.`);
    }

    const authOptions = kind === 'anthropic' ? ['api-key', 'auth-token', 'oauth-token'] : ['api-key', 'auth-token'];
    const authMode = await promptChoice(rl, 'Auth mode', authOptions, 'api-key');

    let secret;
    if (authMode === 'oauth-token') {
      secret = await promptOauthSecret(rl, 'OAuth token');
    } else {
      secret = await promptSecret(rl, 'Secret (API key/token, hidden): ');
    }

    let model;
    if (await promptYesNo(rl, 'Try to list available models from this endpoint?', false)) {
      try {
        const preview = await apiPost('/providers/models-preview', {
          kind,
          baseUrl: baseUrl || undefined,
          authMode,
          secret: secret || undefined,
        });
        if (preview.ok && preview.models?.length) {
          model = await promptChoiceOptional(rl, 'Pick a model', preview.models);
        } else {
          log(`  (could not list models: ${preview.error || 'none returned'})`);
          if (kind === 'anthropic' && baseUrl) {
            log('  (a third-party Anthropic-compatible endpoint may just not implement model listing —');
            log('  that alone doesn\'t mean the real completion endpoint is broken; type the model name below)');
          }
        }
      } catch (e) {
        log(`  (model preview failed: ${e.message})`);
      }
    }
    if (!model) model = await prompt(rl, 'Model name (leave blank ONLY if every agent using this provider sets its own model)');
    if (!model) {
      log('  ⚠ No model set — this provider is skipped when resolving which model to run unless');
      log('  an agent using it has its own model override. A task that reaches it with neither set');
      log('  fails with "No runnable provider: set a default model on the provider or pick one on the agent."');
    }

    let rpm;
    let tpm;
    if (await promptYesNo(rl, 'Set rate limits (rpm/tpm)?', false)) {
      rpm = toIntOrUndef(await prompt(rl, 'Requests/min (blank = none)'));
      tpm = toIntOrUndef(await prompt(rl, 'Tokens/min (blank = none)'));
    }

    try {
      await apiPost('/providers', {
        name,
        kind,
        baseUrl: baseUrl || undefined,
        model,
        authMode,
        secret: secret || undefined,
        rpm,
        tpm,
      });
      log(`  ✓ provider "${name}" created`);
      providers.push(name);
    } catch (e) {
      log(`  ✗ failed to create provider "${name}": ${e.message}`);
    }
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

async function promptChannelField(rl, field) {
  const note = [field.required ? 'required' : null, field.help].filter(Boolean).join(' — ');
  const suffix = note ? ` (${note})` : '';
  if (field.type === 'password') {
    return await promptSecret(rl, `${field.label}${suffix}: `);
  }
  if (field.type === 'list') {
    return splitCsv(await prompt(rl, `${field.label}${suffix} (comma-separated)`));
  }
  if (field.type === 'agent') {
    const agents = await apiGet('/agents').catch(() => []);
    if (!agents.length) return undefined;
    return await promptChoiceOptional(rl, `${field.label}${suffix}`, agents.map((a) => a.name));
  }
  const value = await prompt(rl, `${field.label}${suffix}`, field.placeholder ? undefined : '');
  return value || undefined;
}

async function stepChannels(rl) {
  header('Step 2 — Channels');
  if (!(await promptYesNo(rl, 'Configure a channel now (e.g. Telegram)?', false))) {
    log('  Skipped — configurable later via the dashboard or this wizard.');
    return;
  }
  const kinds = await apiGet('/channels/kinds').catch(() => []);
  const available = kinds.filter((k) => k.available);
  if (!available.length) {
    log('  No channel kind is implemented yet.');
    return;
  }
  let more = true;
  while (more) {
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
      if (await promptYesNo(rl, 'Test this channel now?', true)) {
        const t = await apiPost(`/channels/${row.id}/test`);
        log(t.ok ? '  ✓ test ok' : `  ✗ test failed: ${t.error ?? 'unknown error'}`);
      }
    } catch (e) {
      log(`  ✗ failed to create channel "${name}": ${e.message}`);
    }
    more = await promptYesNo(rl, 'Add another channel?', false);
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

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    log('\naborted');
    process.exit(130);
  });

  try {
    log('Aigentron setup wizard — guided first-run configuration.');
    await stepDeploymentMode(rl, args.orchestratorUrl);

    if (args.advanced) {
      await stepAdvanced(rl, { startUnlocked: true });
      return;
    }

    const providers = await stepProviders(rl);
    await stepChannels(rl);
    await stepAgents(rl, providers);
    await stepRepo(rl);
    await stepAdvanced(rl);

    header('Done');
    log(`Orchestrator: ${BASE}/api/health`);
    log('Dashboard: check DASHBOARD_BASE_URL in your .env (default http://localhost:3000)');
    log('Re-run this wizard any time: node infra/setup-wizard.mjs');
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error(`\nfatal: ${e.message}`);
  process.exit(1);
});
