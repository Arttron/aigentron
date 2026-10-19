import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeBin, loginEnv } from './login-process';

export interface ClaudeProbeResult {
  ok: boolean;
  reply?: string;
  error?: string;
  latencyMs: number;
}

/** What the Claude CLI's `--output-format json` result says: ok with the reply, or the API error in plain words. Pure. */
export function readClaudeProbe(stdout: string): { ok: boolean; reply?: string; error?: string } {
  let d: { is_error?: boolean; result?: unknown; api_error_status?: unknown } | null = null;
  try {
    d = JSON.parse(stdout);
  } catch {
    const tail = stdout.trim().split('\n').slice(-2).join(' ').slice(0, 200);
    return { ok: false, error: `the Claude CLI gave no result${tail ? `: ${tail}` : ''}` };
  }
  const text = typeof d?.result === 'string' ? d.result.trim() : '';
  if (d?.is_error) return { ok: false, error: text || `the Claude API answered with an error${d.api_error_status ? ` (${String(d.api_error_status)})` : ''}` };
  return { ok: true, reply: text.slice(0, 200) };
}

/**
 * A real check of a Claude subscription token: one tiny run of the official CLI with that token (nothing else in its environment), in
 * a scratch folder that is deleted afterwards. It costs one very small request on the subscription. Never throws.
 */
export async function probeClaudeToken(token: string, model: string, timeoutMs = 60_000): Promise<ClaudeProbeResult> {
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'lds-claude-probe-'));
  try {
    const args = ['-p', 'Reply with the single word OK.', '--output-format', 'json', '--max-turns', '1', '--no-session-persistence'];
    if (model.trim()) args.push('--model', model.trim());
    const out = await new Promise<{ stdout: string; error?: string }>((resolve) => {
      execFile(claudeBin(), args, { cwd: dir, env: loginEnv({ CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: join(dir, 'cfg') }), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) resolve({ stdout: '', error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'the Claude CLI was not found on the server' : (err as { killed?: boolean }).killed ? `no answer within ${Math.round(timeoutMs / 1000)} s` : err.message.split('\n')[0] });
        else resolve({ stdout: String(stdout) });
      });
    });
    if (out.error) return { ok: false, error: out.error, latencyMs: Date.now() - started };
    return { ...readClaudeProbe(out.stdout), latencyMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
