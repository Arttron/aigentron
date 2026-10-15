import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildRunnerScript, cleanVersion, compareVersions, parseRelease, parseVersion, resolveStaleStatus, type ReleaseInfo } from './update-core';

const CHECK_TTL_MS = 10 * 60_000;
const MIN_FREE_BYTES = 1.5 * 1024 ** 3;

export interface UpdateEnvironment {
  /** Can this server update itself? */
  canApply: boolean;
  kind: 'bare-metal' | 'docker' | 'other';
  reason: string | null;
  installDir?: string;
}

interface LastUpdate {
  state: 'running' | 'ok' | 'failed';
  version: string;
  startedAt: string;
  finishedAt: string;
  error: string;
}

/**
 * Updating the server from the dashboard / the admin assistant (both behind an approval). A bare-metal install updates itself by
 * running the target release's installer in a detached process (it restarts this very service); a Docker install cannot replace its own
 * container, so it only reports that a newer release exists and says to run `aigentron update` on the server.
 */
@Injectable()
export class UpdateService {
  private readonly logger = new Logger('Update');
  private latest: { at: number; release: ReleaseInfo | null; error: string | null } | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get repo(): string {
    return process.env.UPDATE_REPO?.trim() || 'Arttron/aigentron';
  }
  private get stateDir(): string {
    return join(dirname(this.config.secretsDir), 'update');
  }
  currentVersion(): string {
    return process.env.APP_VERSION ?? 'dev';
  }

  environment(): UpdateEnvironment {
    if (/^(0|false|no)$/i.test(process.env.UPDATE_ENABLED ?? '')) return { canApply: false, kind: 'other', reason: 'Updating from the app is switched off (UPDATE_ENABLED=0).' };
    const appDir = process.env.APP_DIR ?? '';
    const systemd = existsSync('/run/systemd/system');
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    if (appDir && basename(appDir) === 'current' && systemd) {
      if (!root) return { canApply: false, kind: 'bare-metal', reason: 'The service does not run as root, which the installer needs. Run `sudo aigentron update` on the server.', installDir: dirname(appDir) };
      return { canApply: true, kind: 'bare-metal', reason: null, installDir: dirname(appDir) };
    }
    if (existsSync('/.dockerenv')) return { canApply: false, kind: 'docker', reason: 'This server runs in a Docker container, which cannot replace itself. Run `aigentron update` on the server.' };
    return { canApply: false, kind: 'other', reason: 'This is not an installed server (development run).' };
  }

  /** The newest published release (cached for 10 minutes; `force` asks GitHub again). */
  async check(force = false): Promise<{ release: ReleaseInfo | null; error: string | null; checkedAt: string }> {
    if (!force && this.latest && Date.now() - this.latest.at < CHECK_TTL_MS) {
      return { release: this.latest.release, error: this.latest.error, checkedAt: new Date(this.latest.at).toISOString() };
    }
    let release: ReleaseInfo | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'aigentron-update-check' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) error = `GitHub answered ${res.status}`;
      else {
        release = parseRelease(await res.json());
        if (!release) error = 'could not read the latest release';
      }
    } catch (e) {
      error = (e as Error).message;
    }
    this.latest = { at: Date.now(), release, error };
    return { release, error, checkedAt: new Date().toISOString() };
  }

  /** The last update attempt (this server may be the new version that the update just installed). */
  lastUpdate(): (LastUpdate & { logTail: string }) | null {
    try {
      const s = JSON.parse(readFileSync(join(this.stateDir, 'status.json'), 'utf8')) as LastUpdate;
      let logTail = '';
      try {
        logTail = readFileSync(join(this.stateDir, 'update.log'), 'utf8').split('\n').slice(-40).join('\n');
      } catch {
        /* no log */
      }
      return { ...resolveStaleStatus(s), logTail };
    } catch {
      return null;
    }
  }

  private async runningTasks(): Promise<number> {
    return this.prisma.task.count({ where: { status: { in: ['running', 'queued'] } } }).catch(() => 0);
  }

  async status(force = false) {
    const [chk, running] = await Promise.all([this.check(force), this.runningTasks()]);
    const current = this.currentVersion();
    const newer = chk.release ? parseVersion(current) !== null && compareVersions(chk.release.version, current) > 0 : false;
    return {
      current,
      latest: chk.release?.version ?? null,
      newer,
      notes: chk.release?.notes ?? '',
      url: chk.release?.url ?? '',
      publishedAt: chk.release?.publishedAt ?? null,
      checkedAt: chk.checkedAt,
      checkError: chk.error,
      environment: this.environment(),
      runningTasks: running,
      last: this.lastUpdate(),
    };
  }

  /**
   * Start the update (caller has been approved/confirmed). Returns at once — the installer runs detached and restarts this service,
   * so the caller will lose the connection for a minute or two.
   */
  async apply(input: { version?: string; force?: boolean; by?: string }): Promise<{ started: true; version: string }> {
    const env = this.environment();
    if (!env.canApply) throw new BadRequestException(env.reason ?? 'This server cannot update itself.');
    if (this.lastUpdate()?.state === 'running') throw new ConflictException('An update is already running.');
    const current = this.currentVersion();
    let target = input.version ? cleanVersion(input.version) : '';
    if (!target || target === 'latest') {
      const { release, error } = await this.check(true);
      if (!release) throw new BadRequestException(`Could not find the latest release (${error ?? 'unknown'}).`);
      target = release.version;
    }
    if (!parseVersion(target)) throw new BadRequestException('Give a version like 0.1.48, or leave it empty for the latest.');
    if (parseVersion(current) && compareVersions(target, current) <= 0) throw new BadRequestException(`v${target} is not newer than the installed ${current}.`);
    const running = await this.runningTasks();
    if (running > 0 && !input.force) {
      throw new ConflictException(`${running} task${running === 1 ? ' is' : 's are'} running or queued — the restart would interrupt ${running === 1 ? 'it' : 'them'}. Wait for them, or confirm to update anyway.`);
    }
    const installDir = env.installDir!;
    try {
      const free = statfsSync(installDir);
      if (free.bavail * free.bsize < MIN_FREE_BYTES) throw new BadRequestException('Less than 1.5 GB is free on the server disk — free some space first.');
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
    }

    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const script = join(this.stateDir, `run-${target}.sh`);
    writeFileSync(script, buildRunnerScript({ repo: this.repo, version: target, installDir, dataDir: dirname(this.config.secretsDir), stateDir: this.stateDir }), { mode: 0o700 });
    chmodSync(script, 0o700);
    this.logger.warn(`Updating ${current} → ${target}${input.by ? ` (requested by ${input.by})` : ''}`);
    if (process.env.UPDATE_DRY_RUN === '1') return { started: true, version: target };
    const unit = `aigentron-update-${Date.now()}`;
    // A transient systemd unit lives outside this service's cgroup, so restarting the service does not kill the updater.
    const [cmd, args] = existsSync('/run/systemd/system')
      ? ['systemd-run', ['--unit', unit, '--collect', '--no-block', `--setenv=PATH=${process.env.PATH ?? ''}`, '/bin/sh', script]]
      : ['setsid', ['/bin/sh', script]];
    const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => this.logger.error(`could not start the updater: ${e.message}`));
    child.unref();
    return { started: true, version: target };
  }
}
