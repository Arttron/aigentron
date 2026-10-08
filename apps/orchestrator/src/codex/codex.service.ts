import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

const pexec = promisify(execFile);

export interface CodexStatus {
  installed: boolean;
  loggedIn: boolean;
  /** Human-readable status line from the CLI (or why it is unavailable). */
  message: string;
}

/**
 * Locates the Codex CLI and the shared sign-in (`auth.json`) that every Codex run copies
 * into its own per-run CODEX_HOME. The shared home is under the persistent agent dir so a
 * ChatGPT login survives container recreation.
 */
@Injectable()
export class CodexService implements OnModuleInit {
  private readonly logger = new Logger(CodexService.name);

  constructor(private readonly config: AppConfigService) {}

  get bin(): string {
    return process.env.CODEX_BIN?.trim() || 'codex';
  }

  /** Where the shared ChatGPT sign-in lives: `CODEX_AUTH_HOME`, else `<secretsDir>/codex` (outside the agent tree). */
  private get preferredHome(): string {
    return process.env.CODEX_AUTH_HOME?.trim() || join(this.config.secretsDir, 'codex');
  }

  /** Older locations a sign-in may still sit in: inside the agent tree (pre-0.1.27) or a plain `codex login`'s ~/.codex. */
  private get legacyHomes(): string[] {
    return [join(this.config.agentDir, '.codex-home'), join(homedir(), '.codex')];
  }

  /**
   * The directory holding the signed-in auth.json. Normally the secrets dir; if the sign-in is still in an older
   * location (and not yet migrated) that one is used so a login is never reported as lost.
   */
  get authHome(): string {
    const preferred = this.preferredHome;
    if (existsSync(join(preferred, 'auth.json'))) return preferred;
    return this.legacyHomes.find((h) => existsSync(join(h, 'auth.json'))) ?? preferred;
  }

  /**
   * One-time migration at boot: move a sign-in found in the agent tree (readable by every agent run) into the secrets
   * dir, with tight permissions. A sign-in in ~/.codex is copied (that dir isn't ours to delete).
   */
  onModuleInit(): void {
    try {
      const target = this.preferredHome;
      if (existsSync(join(target, 'auth.json'))) return;
      for (const legacy of this.legacyHomes) {
        const src = join(legacy, 'auth.json');
        if (!existsSync(src)) continue;
        mkdirSync(target, { recursive: true, mode: 0o700 });
        copyFileSync(src, join(target, 'auth.json'));
        chmodSync(join(target, 'auth.json'), 0o600);
        if (legacy.startsWith(this.config.agentDir)) rmSync(legacy, { recursive: true, force: true });
        this.logger.log(`Moved the Codex sign-in from ${legacy} to ${target}`);
        return;
      }
    } catch (err) {
      this.logger.warn(`Codex sign-in migration skipped: ${(err as Error).message}`);
    }
  }

  async status(): Promise<CodexStatus> {
    try {
      const { stdout, stderr } = await pexec(this.bin, ['login', 'status'], {
        env: { ...process.env, CODEX_HOME: this.authHome },
        timeout: 15_000,
      });
      const message = `${stdout}${stderr}`.trim() || 'unknown';
      return { installed: true, loggedIn: /logged in/i.test(message) && !/not logged in/i.test(message), message };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (e.code === 'ENOENT') {
        return { installed: false, loggedIn: false, message: `Codex CLI not found ("${this.bin}") — install it: npm i -g @openai/codex` };
      }
      const message = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message;
      return { installed: true, loggedIn: false, message };
    }
  }
}
