import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';

const exec = promisify(execFile);

export interface VerifyResult {
  /** Whether any verify commands were configured/run. */
  ran: boolean;
  ok: boolean;
  /** Combined output of the first failing command (truncated). */
  output: string;
}

/** Runs a project's verification commands in a task's checkout (the cwd the agent worked in). */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  async verify(commands: readonly string[], cwd: string): Promise<VerifyResult> {
    if (!commands.length) return { ran: false, ok: true, output: '' };

    for (const cmd of commands) {
      this.logger.log(`verify: ${cmd}`);
      try {
        await exec('sh', ['-c', cmd], {
          cwd,
          timeout: 10 * 60_000,
          maxBuffer: 8 * 1024 * 1024,
          // Minimal env: verify runs repo scripts that agents may have edited — never hand them the orchestrator's secrets.
          env: Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'CI', 'NODE_ENV', 'XDG_CACHE_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].flatMap((k) => (process.env[k] !== undefined ? [[k, process.env[k]!]] : []))),
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const body = (e.stdout ?? '') + (e.stderr ?? '') || e.message || 'command failed';
        return { ran: true, ok: false, output: `$ ${cmd}\n${body}`.slice(0, 6000) };
      }
    }
    return { ran: true, ok: true, output: '' };
  }
}
