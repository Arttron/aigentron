import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';

const exec = promisify(execFile);

export interface VerifyResult {
  /** Whether any verify commands were configured/run. */
  ran: boolean;
  ok: boolean;
  /** Combined output of the first failing command (truncated). */
  output: string;
}

/** Runs the configured verification commands in a task's worktree. */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(private readonly settings: SettingsService) {}

  async verify(worktreePath: string): Promise<VerifyResult> {
    const commands = await this.settings.verifyCommands();
    if (!commands.length) return { ran: false, ok: true, output: '' };

    // Run in the configured project subdir (e.g. a monorepo package), else the
    // worktree root — the same cwd the agent worked in.
    const cwd = await this.settings.workDir(worktreePath);

    for (const cmd of commands) {
      this.logger.log(`verify: ${cmd}`);
      try {
        await exec('sh', ['-c', cmd], { cwd, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const body = (e.stdout ?? '') + (e.stderr ?? '') || e.message || 'command failed';
        return { ran: true, ok: false, output: `$ ${cmd}\n${body}`.slice(0, 6000) };
      }
    }
    return { ran: true, ok: true, output: '' };
  }
}
