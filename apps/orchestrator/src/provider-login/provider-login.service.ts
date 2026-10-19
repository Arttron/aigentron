import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import { ProvidersService } from '../providers/providers.service';
import { claudeDriver, codexDriver } from './login-drivers';
import { claudeBin, loginEnv, shq, spawnOnTty, spawnPlain } from './login-process';
import { LoginSession, type LoginDriver } from './login-session';
import type { LoginView } from './login-core';

const pexec = promisify(execFile);

export type LoginFlavor = 'codex' | 'claude';

export interface LoginStatus {
  /** Can this provider be signed in from here at all (a subscription provider)? */
  supported: boolean;
  flavor: LoginFlavor | null;
  loggedIn: boolean;
  /** One line: who/what is signed in, or why not. */
  message: string;
  /** The attempt in progress (or the last one), if any. */
  session: LoginView | null;
}

/**
 * Sign in to a subscription provider from the dashboard (docs/provider-login.md). One attempt per provider at a time; the
 * CLI of the provider does the real work (Codex: device code; Claude: setup-token with a pasted code) and the credential
 * lands where the runtime already looks for it — the secrets dir for Codex, the provider's secret for Claude.
 */
@Injectable()
export class ProviderLoginService {
  private readonly logger = new Logger('ProviderLogin');
  private readonly sessions = new Map<string, LoginSession>();
  /** Scratch config dirs of running Claude sign-ins, removed when the attempt settles. */
  private readonly scratch = new Map<string, string>();
  /** The existing Codex sign-in, kept while a new attempt runs: `codex login` wipes it at the start, and an abandoned attempt must not leave the person signed out. */
  private readonly previousAuth = new Map<string, { file: string; data: Buffer }>();

  constructor(
    private readonly providers: ProvidersService,
    private readonly codex: CodexService,
  ) {}

  private async flavorOf(name: string): Promise<{ flavor: LoginFlavor | null; row: Awaited<ReturnType<ProvidersService['getRow']>> }> {
    const row = await this.providers.getRow(name).catch(() => null);
    if (!row) throw new NotFoundException(`No provider named "${name}".`);
    if (row.kind === 'codex') return { flavor: 'codex', row };
    if (row.kind === 'anthropic' && row.authMode === 'oauth-token') return { flavor: 'claude', row };
    return { flavor: null, row };
  }

  async status(name: string): Promise<LoginStatus> {
    const { flavor, row } = await this.flavorOf(name);
    const session = this.sessions.get(name)?.view() ?? null;
    if (!flavor) return { supported: false, flavor, loggedIn: false, message: 'This provider uses an API key — there is nothing to sign in to.', session: null };
    if (flavor === 'codex') {
      const s = await this.codex.status();
      return { supported: true, flavor, loggedIn: s.loggedIn, message: s.message, session };
    }
    return {
      supported: true,
      flavor,
      loggedIn: Boolean(row.secret),
      message: row.secret ? `Signed in (token …${row.secret.slice(-4)}, valid about a year).` : 'Not signed in.',
      session,
    };
  }

  async start(name: string): Promise<LoginView> {
    const { flavor } = await this.flavorOf(name);
    if (!flavor) throw new BadRequestException('This provider uses an API key — there is nothing to sign in to.');
    const running = this.sessions.get(name);
    if (running?.active) return running.view();

    const driver = await this.driverFor(flavor, name);
    const session = new LoginSession(
      driver.driver,
      driver.spawn,
      (url) => this.callback(url),
      () => void this.cleanup(name),
    );
    this.sessions.set(name, session);
    session.start();
    this.logger.log(`Sign-in started for provider "${name}" (${flavor})`);
    return session.view();
  }

  async submit(name: string, code: string): Promise<LoginView> {
    const session = this.sessions.get(name);
    if (!session) throw new BadRequestException('No sign-in is running for this provider — press “Sign in” first.');
    try {
      await session.submit(code);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return session.view();
  }

  cancel(name: string): LoginView | null {
    const session = this.sessions.get(name);
    session?.cancel();
    return session?.view() ?? null;
  }

  async logout(name: string): Promise<LoginStatus> {
    const { flavor } = await this.flavorOf(name);
    if (!flavor) throw new BadRequestException('This provider uses an API key — there is nothing to sign out of.');
    this.sessions.get(name)?.cancel();
    if (flavor === 'codex') {
      await pexec(this.codex.bin, ['logout'], { env: { ...process.env, CODEX_HOME: this.codex.authHome }, timeout: 15_000 }).catch((e: Error) => {
        throw new BadRequestException(`Codex could not sign out: ${e.message.split('\n')[0]}`);
      });
    } else {
      await this.providers.update(name, { secret: null });
    }
    this.logger.log(`Signed out of provider "${name}"`);
    return this.status(name);
  }

  private async driverFor(flavor: LoginFlavor, name: string): Promise<{ driver: LoginDriver; spawn: () => ReturnType<typeof spawnPlain> }> {
    if (flavor === 'codex') {
      const file = join(this.codex.authHome, 'auth.json');
      const data = await readFile(file).catch(() => null);
      if (data) this.previousAuth.set(name, { file: join(this.codex.loginHome, 'auth.json'), data });
      return {
        driver: codexDriver(async () => {
          const s = await this.codex.status();
          if (!s.loggedIn) throw new Error(s.message);
          return `Signed in — ${s.message}`;
        }),
        spawn: () => spawnPlain(this.codex.bin, ['login', '--device-auth'], loginEnv({ CODEX_HOME: this.codex.loginHome })),
      };
    }
    // Claude: the CLI writes its own config next to the token; keep that out of anyone's real one.
    const dir = await mkdtemp(join(tmpdir(), 'lds-claude-login-'));
    this.scratch.set(name, dir);
    return {
      driver: claudeDriver(async (token) => {
        await this.providers.update(name, { authMode: 'oauth-token', secret: token });
        return 'Signed in — the token is saved for this provider (valid about a year).';
      }),
      spawn: () => spawnOnTty(`${shq(claudeBin())} setup-token`, loginEnv({ CLAUDE_CONFIG_DIR: dir })),
    };
  }

  /** The person's browser could not reach `localhost:<port>/callback` (it is not on this machine) — the CLI listens here, so ask it ourselves. */
  private async callback(url: string): Promise<void> {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  }

  private async cleanup(name: string): Promise<void> {
    const prev = this.previousAuth.get(name);
    if (prev) {
      this.previousAuth.delete(name);
      const ok = this.sessions.get(name)?.view().phase === 'done';
      if (!ok) {
        // The CLI is being killed right now and may clean up its own files while it goes: restore after it is gone.
        await new Promise((r) => setTimeout(r, 1500));
        // Cancelled / failed / timed out: put the earlier sign-in back unless the CLI wrote a new one.
        const have = await readFile(prev.file).then(() => true, () => false);
        if (!have) {
          await mkdir(join(prev.file, '..'), { recursive: true, mode: 0o700 }).catch(() => undefined);
          await writeFile(prev.file, prev.data, { mode: 0o600 }).catch((e: Error) => this.logger.warn(`Could not restore the earlier Codex sign-in: ${e.message}`));
          await chmod(prev.file, 0o600).catch(() => undefined);
          this.logger.log(`Restored the earlier sign-in of provider "${name}" after an unfinished attempt`);
        }
      }
    }
    const dir = this.scratch.get(name);
    if (!dir) return;
    this.scratch.delete(name);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
