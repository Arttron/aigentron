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

export const FALLBACK_CODEX_MODELS = ['gpt-6.1-sol'];

/** `codex debug models` JSON → the model names Codex itself offers (the visible ones, best first). */
export function parseCodexModels(json: unknown): string[] {
  const list = (json && typeof json === 'object' ? (json as { models?: unknown }).models : null) as { slug?: unknown; visibility?: unknown; priority?: unknown }[] | null;
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => typeof m.slug === 'string' && m.slug && m.visibility !== 'hide')
    .sort((a, b) => Number(a.priority ?? 999) - Number(b.priority ?? 999))
    .map((m) => m.slug as string);
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

  /** Where a NEW sign-in should be written (`codex login` with CODEX_HOME set to this). */
  get loginHome(): string {
    return this.preferredHome;
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

  /** Codex refuses to start when CODEX_HOME points at a folder that does not exist (before anyone has signed in) — make sure it does. */
  private ensureHome(): string {
    const home = this.authHome;
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
    } catch {
      /* the CLI will report it */
    }
    return home;
  }

  /** The CLI's own diagnostic lines ("WARNING: proceeding, even though…") are noise next to the real answer. */
  private clean(text: string): string {
    return text
      .split('\n')
      .filter((l) => l.trim() && !/^WARNING: proceeding/i.test(l.trim()))
      .join(' ')
      .trim();
  }

  private modelsCache: { at: number; models: string[] } | null = null;

  /** The models the Codex CLI offers for this account (its own catalog, via `codex debug models`; cached 10 minutes). */
  async models(): Promise<string[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 10 * 60_000) return this.modelsCache.models;
    try {
      const { stdout } = await pexec(this.bin, ['debug', 'models'], { env: { ...process.env, CODEX_HOME: this.ensureHome() }, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      const models = parseCodexModels(JSON.parse(stdout));
      if (models.length) {
        this.modelsCache = { at: Date.now(), models };
        return models;
      }
    } catch (err) {
      this.logger.warn(`could not read the Codex model catalog: ${(err as Error).message.slice(0, 120)}`);
    }
    return FALLBACK_CODEX_MODELS;
  }

  async status(): Promise<CodexStatus> {
    try {
      const { stdout, stderr } = await pexec(this.bin, ['login', 'status'], {
        env: { ...process.env, CODEX_HOME: this.ensureHome() },
        timeout: 15_000,
      });
      const message = this.clean(`${stdout}\n${stderr}`) || 'unknown';
      return { installed: true, loggedIn: /logged in/i.test(message) && !/not logged in/i.test(message), message };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (e.code === 'ENOENT') {
        return { installed: false, loggedIn: false, message: `Codex CLI not found ("${this.bin}") — install it: npm i -g @openai/codex` };
      }
      const message = this.clean(`${e.stdout ?? ''}\n${e.stderr ?? ''}`) || e.message;
      return { installed: true, loggedIn: false, message };
    }
  }
}
