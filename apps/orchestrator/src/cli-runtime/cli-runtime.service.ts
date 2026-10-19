import { execFile, spawn } from 'node:child_process';
import { mkdir, statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import { AppConfigService } from '../config/app-config.service';
import { CLI_RUNTIMES, cliDirOf, npmInstallArgs, type CliRuntime } from './runtime-registry';

const pexec = promisify(execFile);
const MIN_FREE_MB = 500;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export interface RuntimeStatus {
  kind: CliRuntime['kind'];
  label: string;
  installed: boolean;
  version: string | null;
  /** can the server install it itself (npm present)? */
  installable: boolean;
}

export type InstallPhase = 'idle' | 'installing' | 'done' | 'failed';
export interface InstallView {
  phase: InstallPhase;
  message: string;
}

/** Installs an agent runtime's CLI on demand (Codex) into <data>/cli, one install at a time; Claude's CLI ships with the SDK. */
@Injectable()
export class CliRuntimeService {
  private readonly logger = new Logger('CliRuntime');
  private running: Promise<InstallView> | null = null;
  private last: InstallView = { phase: 'idle', message: '' };

  constructor(
    private readonly config: AppConfigService,
    private readonly codex: CodexService,
  ) {}

  private get cliDir(): string {
    return cliDirOf(this.config.secretsDir);
  }

  async status(kind: CliRuntime['kind']): Promise<RuntimeStatus> {
    const rt = CLI_RUNTIMES[kind];
    let version: string | null = null;
    try {
      const { stdout } = await pexec(this.codex.bin, ['--version'], { timeout: 15_000 });
      version = stdout.trim().split(/\s+/).pop() || 'unknown';
    } catch {
      version = null;
    }
    const npm = await pexec('npm', ['--version'], { timeout: 10_000 }).then(() => true, () => false);
    return { kind, label: rt.label, installed: version !== null, version, installable: npm };
  }

  view(): InstallView {
    return this.last;
  }

  get installing(): boolean {
    return this.running !== null;
  }

  /** Install (or finish a running install). Resolves with the outcome; never rejects. */
  install(kind: CliRuntime['kind']): Promise<InstallView> {
    if (this.running) return this.running;
    const p = this.doInstall(CLI_RUNTIMES[kind]).finally(() => {
      this.running = null;
    });
    this.running = p;
    return p;
  }

  private async doInstall(rt: CliRuntime): Promise<InstallView> {
    this.last = { phase: 'installing', message: `Installing the ${rt.label} (${rt.pkg}@${rt.version}) — about a minute…` };
    try {
      await mkdir(this.cliDir, { recursive: true });
      const free = await statfs(this.cliDir).then((s) => Math.floor((Number(s.bavail) * Number(s.bsize)) / 1_048_576)).catch(() => null);
      if (free !== null && free < MIN_FREE_MB) {
        return this.fail(`Not enough free disk space to install the ${rt.label}: ${free} MB free, ${MIN_FREE_MB} MB needed. Free some space (or enlarge the disk) and try again.`);
      }
      if (!(await pexec('npm', ['--version'], { timeout: 10_000 }).then(() => true, () => false))) {
        return this.fail(`npm is not available on this server, so the ${rt.label} cannot be installed from here. Install Node.js/npm, or install it by hand: npm i -g ${rt.pkg}@${rt.version}`);
      }
      const out = await new Promise<{ code: number | null; tail: string }>((resolve) => {
        const child = spawn('npm', npmInstallArgs(this.cliDir, rt), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_config_update_notifier: 'false' } });
        let tail = '';
        const keep = (d: Buffer) => (tail = (tail + d.toString('utf8')).slice(-1500));
        child.stdout?.on('data', keep);
        child.stderr?.on('data', keep);
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          tail += '\n(timed out)';
        }, INSTALL_TIMEOUT_MS);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve({ code, tail });
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          resolve({ code: 1, tail: e.message });
        });
      });
      if (out.code !== 0) return this.fail(`Installing the ${rt.label} failed: ${out.tail.trim().split('\n').slice(-3).join(' · ').slice(0, 300) || 'npm exited with an error'}`);
      const st = await this.status(rt.kind);
      if (!st.installed) return this.fail(`npm finished but the ${rt.label} does not start (${this.codex.bin}).`);
      this.logger.log(`${rt.label} ${st.version} installed into ${this.cliDir}`);
      this.last = { phase: 'done', message: `${rt.label} ${st.version} installed.` };
      return this.last;
    } catch (err) {
      return this.fail(`Installing the ${rt.label} failed: ${(err as Error).message.slice(0, 300)}`);
    }
  }

  private fail(message: string): InstallView {
    this.logger.warn(message);
    this.last = { phase: 'failed', message };
    return this.last;
  }
}
