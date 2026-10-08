import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAgentEnv } from './env';
import { emptyUsage } from './usage';
import type { AgentEvent, AgentEventHandler, AgentRunResult, RunAgentParams } from './types';

const OUTPUT_CAP = 4000;
const KILL_GRACE_MS = 5000;
/** Env var through which the HTTP MCP bearer token reaches Codex (never written to disk). */
export const INTERNAL_MCP_TOKEN_ENV = 'LDS_INTERNAL_MCP_TOKEN';

const cap = (s: string) => (s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}…` : s);
const tomlStr = (s: string) => JSON.stringify(s); // JSON string literals are valid TOML basic strings

/** Render the agent's SDK-style MCP server configs (+ the internal one) as Codex config.toml tables. */
export function renderCodexConfig(params: RunAgentParams, model: string | undefined, warn: (m: string) => void): string {
  const lines: string[] = [];
  if (model) lines.push(`model = ${tomlStr(model)}`);
  lines.push('');
  for (const [name, raw] of Object.entries(params.mcpServers ?? {})) {
    const cfg = raw as { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
    if (cfg.type === 'sse') {
      warn(`MCP server "${name}" uses SSE, which Codex does not support — skipped`);
      continue;
    }
    lines.push(`[mcp_servers.${tomlStr(name)}]`);
    if (cfg.command) {
      lines.push(`command = ${tomlStr(cfg.command)}`);
      if (cfg.args?.length) lines.push(`args = [${cfg.args.map(tomlStr).join(', ')}]`);
      if (cfg.env && Object.keys(cfg.env).length) {
        lines.push(`[mcp_servers.${tomlStr(name)}.env]`);
        for (const [k, v] of Object.entries(cfg.env)) lines.push(`${tomlStr(k)} = ${tomlStr(v)}`);
      }
    } else if (cfg.url) {
      lines.push(`url = ${tomlStr(cfg.url)}`);
      if (cfg.headers && Object.keys(cfg.headers).length) {
        lines.push(`[mcp_servers.${tomlStr(name)}.http_headers]`);
        for (const [k, v] of Object.entries(cfg.headers)) lines.push(`${tomlStr(k)} = ${tomlStr(v)}`);
      }
    } else {
      warn(`MCP server "${name}" has no command/url — skipped`);
    }
    lines.push('');
  }
  if (params.codex?.internalMcp) {
    lines.push('[mcp_servers.lds_internal]');
    lines.push(`url = ${tomlStr(params.codex.internalMcp.url)}`);
    lines.push(`bearer_token_env_var = ${tomlStr(INTERNAL_MCP_TOKEN_ENV)}`);
    lines.push('startup_timeout_sec = 20');
    lines.push('');
  }
  return lines.join('\n');
}

function renderHooks(params: RunAgentParams): string {
  const hook = params.hook;
  if (!hook) return JSON.stringify({ hooks: {} });
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: `node ${hook.scriptPath}`, timeout: hook.approvalTimeoutSeconds + 15 }],
        },
      ],
    },
  });
}

/**
 * After a run the per-run home must not keep credentials or bulky caches: `auth.json` was already synced back to
 * the shared home, and `cache/` + `plugins/` are re-downloaded on demand (tens of MB per run). config.toml/hooks.json (they hold MCP tokens after secret substitution) are removed and
 * rewritten each run, and `sessions/` + the state db stay because follow-ups resume from them.
 */
export async function scrubRunHome(home: string): Promise<void> {
  await Promise.all(
    ['auth.json', 'config.toml', 'hooks.json', 'cache', 'plugins', 'models_cache.json', 'shell_snapshots'].map((n) =>
      rm(join(home, n), { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}

async function mtime(path: string): Promise<number> {
  return stat(path).then((s) => s.mtimeMs, () => 0);
}

/** Copy the shared sign-in into the per-run home; returns false when there is none. */
async function seedAuth(authHome: string, home: string): Promise<boolean> {
  const src = join(authHome, 'auth.json');
  if (!(await mtime(src))) return false;
  await copyFile(src, join(home, 'auth.json'));
  await chmod(join(home, 'auth.json'), 0o600).catch(() => undefined);
  return true;
}

/** Codex rotates refresh tokens inside auth.json — keep the shared copy current. */
async function syncAuthBack(authHome: string, home: string): Promise<void> {
  const mine = join(home, 'auth.json');
  const shared = join(authHome, 'auth.json');
  if ((await mtime(mine)) <= (await mtime(shared))) return;
  const [a, b] = await Promise.all([readFile(mine, 'utf8').catch(() => ''), readFile(shared, 'utf8').catch(() => '')]);
  if (a && a !== b) await copyFile(mine, shared);
}

type CodexItem = {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: { content?: { type?: string; text?: string }[] } | null;
  error?: { message?: string } | string | null;
  changes?: { path: string; kind: string }[];
};

/** Map one Codex JSONL event to our normalized events. Exported for tests/tolerance checks. */
export function mapCodexEvent(ev: Record<string, unknown>): AgentEvent[] {
  const type = ev.type as string;
  const item = ev.item as CodexItem | undefined;
  if (!item || (type !== 'item.started' && type !== 'item.completed')) return [];
  const started = type === 'item.started';

  switch (item.type) {
    case 'agent_message':
      return !started && item.text ? [{ kind: 'assistant', text: item.text }] : [];
    case 'command_execution':
      return started
        ? [{ kind: 'tool_use', toolName: 'Bash', input: { command: item.command ?? '' }, text: item.command ?? '' }]
        : [{ kind: 'tool_result', text: cap(item.aggregated_output ?? ''), isError: item.exit_code != null && item.exit_code !== 0 }];
    case 'mcp_tool_call': {
      const name = `mcp__${item.server ?? '?'}__${item.tool ?? '?'}`;
      if (started) {
        return [{ kind: 'tool_use', toolName: name, input: item.arguments ?? {}, text: `${name} ${JSON.stringify(item.arguments ?? {})}` }];
      }
      const text = (item.result?.content ?? []).map((c) => c.text ?? '').join('');
      const err = typeof item.error === 'string' ? item.error : item.error?.message;
      return [{ kind: 'tool_result', text: cap(err ?? text), isError: Boolean(err) || item.status === 'failed' }];
    }
    case 'file_change': {
      const paths = (item.changes ?? []).map((c) => `${c.kind} ${c.path}`).join(', ');
      return started
        ? [{ kind: 'tool_use', toolName: 'apply_patch', input: { changes: item.changes ?? [] }, text: paths }]
        : [{ kind: 'tool_result', text: paths, isError: item.status === 'failed' }];
    }
    case 'error': {
      const msg = item.message ?? '';
      // Codex announces our (intentional) hook-trust bypass on every run — noise.
      if (!msg || /dangerously-bypass-hook-trust/.test(msg)) return [];
      return [{ kind: 'stderr', text: msg }];
    }
    default:
      return []; // reasoning, web_search, todo lists, … — not surfaced
  }
}

/**
 * Run (or resume) one headless Codex agent turn for a task via `codex exec --json`.
 * Mirrors runAgent(): normalized events out, an AgentRunResult back, `sessionId` = the
 * Codex thread id. Isolation comes from a per-run CODEX_HOME + our PreToolUse hook (Codex's
 * own sandbox can't run inside Docker, so we use full-access mode behind the hook gate).
 */
export async function runCodex(params: RunAgentParams, onEvent: AgentEventHandler): Promise<AgentRunResult> {
  const opts = params.codex;
  if (!opts) throw new Error('runCodex: params.codex is required');
  const result: AgentRunResult = {
    sessionId: params.resumeSessionId ?? null,
    isError: false,
    result: '',
    maxTurnsExceeded: false,
    usage: emptyUsage(),
  };
  const warn = (text: string) => onEvent({ kind: 'stderr', text });

  await mkdir(opts.home, { recursive: true, mode: 0o700 });
  await chmod(opts.home, 0o700).catch(() => undefined);
  const haveLogin = opts.apiKey ? true : await seedAuth(opts.authHome, opts.home);
  if (!haveLogin) {
    result.isError = true;
    result.result = 'Codex is not signed in — sign in with ChatGPT (or set an API key) on the provider first.';
    onEvent({ kind: 'result', isError: true, text: result.result, numTurns: 0, costUsd: 0 });
    return result;
  }

  // A follow-up resumes a stored Codex thread — but the run folder holding it may have been cleaned up since.
  // Don't fail the task on that: start a fresh thread and say so.
  if (params.resumeSessionId && !(await mtime(join(opts.home, 'sessions')))) {
    onEvent({ kind: 'stderr', text: 'The earlier Codex session was cleaned up — continuing in a fresh thread (previous context is not available).' });
    params = { ...params, resumeSessionId: undefined };
  }

  const model = params.modelLabel || undefined;
  await writeFile(join(opts.home, 'config.toml'), renderCodexConfig(params, model, warn));
  await writeFile(join(opts.home, 'hooks.json'), renderHooks(params));
  await writeFile(join(opts.home, 'AGENTS.md'), params.appendSystemPrompt ?? '');

  const env = buildAgentEnv({ ANTHROPIC_MODEL: '' }, process.env, params.workspaceRoot ?? params.cwd, params.hook);
  delete env.ANTHROPIC_MODEL; // Anthropic vars mean nothing to Codex
  env.CODEX_HOME = opts.home;
  if (opts.apiKey) env.CODEX_API_KEY = opts.apiKey;
  if (opts.internalMcp) env[INTERNAL_MCP_TOKEN_ENV] = opts.internalMcp.token;
  if (params.disallowedTools?.length) env.LDS_DISALLOWED_TOOLS = params.disallowedTools.join(',');
  if (params.allowedTools?.length) env.LDS_ALLOWED_TOOLS = params.allowedTools.join(',');
  // Hooks and shell tools need a usable PATH/HOME; buildAgentEnv's allowlist supplies them.

  const args = ['exec'];
  if (params.resumeSessionId) args.push('resume');
  args.push(
    '--json',
    '--skip-git-repo-check',
    // The container is the sandbox (Codex's own bwrap sandbox can't run in Docker) and our
    // PreToolUse hook is the gate — so no Codex approval prompts either.
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
  );
  if (model) args.push('-m', model);
  if (params.resumeSessionId) args.push(params.resumeSessionId);
  args.push('-'); // prompt from stdin (no argv size limit)

  const child = spawn(opts.bin ?? 'codex', args, {
    cwd: params.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // own process group so abort can kill hook/tool children too
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(params.prompt);

  const killGroup = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      /* already gone */
    }
  };
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    killGroup('SIGTERM');
    setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
  };
  if (params.abortController?.signal.aborted) onAbort();
  else params.abortController?.signal.addEventListener('abort', onAbort, { once: true });

  let lastMessage = '';
  let failure = '';
  let sawCompleted = false;
  let turns = 0;
  const started = Date.now();

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    params.onProgress?.();
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // non-JSON noise on stdout
    }
    switch (ev.type) {
      case 'thread.started': {
        result.sessionId = (ev.thread_id as string) ?? result.sessionId;
        onEvent({
          kind: 'system',
          sessionId: result.sessionId ?? '',
          model: params.modelLabel,
          text: `agent started — runtime=codex provider=${params.providerLabel} model=${params.modelLabel}`,
        });
        return;
      }
      case 'turn.completed': {
        sawCompleted = true;
        turns += 1;
        const u = (ev.usage ?? {}) as Record<string, number>;
        const input = Number(u.input_tokens ?? 0);
        const cached = Number(u.cached_input_tokens ?? 0);
        result.usage.inputTokens += Math.max(0, input - cached); // OpenAI counts cached inside input; we track them apart
        result.usage.cacheReadTokens += cached;
        result.usage.cacheCreationTokens += Number(u.cache_write_input_tokens ?? 0);
        result.usage.outputTokens += Number(u.output_tokens ?? 0);
        return;
      }
      case 'turn.failed': {
        failure = ((ev.error as { message?: string } | undefined)?.message ?? 'Codex turn failed');
        return;
      }
      case 'error': {
        // Transient reconnect notices and the like — surface as stderr, don't fail on them alone.
        const msg = String(ev.message ?? '');
        if (msg && !/dangerously-bypass-hook-trust/.test(msg)) onEvent({ kind: 'stderr', text: msg });
        return;
      }
      default: {
        const mapped = mapCodexEvent(ev);
        for (const e of mapped) {
          if (e.kind === 'assistant') lastMessage = e.text;
          onEvent(e);
        }
      }
    }
  };

  let stdoutBuf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      handleLine(stdoutBuf.slice(0, nl));
      stdoutBuf = stdoutBuf.slice(nl + 1);
    }
  });
  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrTail = (stderrTail + text).slice(-2000);
    // tracing logs: keep ERROR lines only, the rest is chatter
    for (const l of text.split('\n')) if (/\bERROR\b/.test(l) && !/responses_websocket/.test(l)) onEvent({ kind: 'stderr', text: l.slice(0, 500) });
  });

  const code = await new Promise<number | null>((resolve) => {
    child.on('error', (err) => {
      failure = failure || `failed to start codex: ${err.message}`;
      resolve(null);
    });
    child.on('close', (c) => resolve(c));
  });
  if (stdoutBuf.trim()) handleLine(stdoutBuf);
  params.abortController?.signal.removeEventListener('abort', onAbort);
  await syncAuthBack(opts.authHome, opts.home).catch(() => undefined);
  await scrubRunHome(opts.home);

  result.usage.numTurns = turns;
  result.usage.apiMs = Date.now() - started;
  if (aborted) {
    result.isError = true;
    result.result = 'agent run aborted';
  } else if (failure || (!sawCompleted && code !== 0)) {
    result.isError = true;
    result.result = failure || stderrTail.trim().split('\n').slice(-3).join(' ') || `codex exited with code ${code}`;
  } else {
    result.result = lastMessage;
  }
  onEvent({
    kind: 'result',
    isError: result.isError,
    text: result.result || (result.isError ? 'agent run errored' : 'agent run completed'),
    numTurns: turns,
    costUsd: 0, // subscription / not metered per token here
  });
  return result;
}
