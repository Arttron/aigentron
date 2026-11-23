import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { SecretJsonFile } from '../security/secret-json-file';
import { LocalBridgeService } from './local-bridge.service';
import { LocalDevicesService } from './local-devices.service';
import { sameRemote, type RepoStatus } from './local-repos';

/** «This project's agents may read this repository on this computer» — made by a person on the dashboard. */
export interface LocalBinding {
  id: string;
  projectId: string;
  deviceId: string;
  repoId: string;
  createdAt: string;
  createdById: string;
}

export interface ResolvedBinding {
  binding: LocalBinding;
  deviceId: string;
  deviceLabel: string;
  repo: RepoStatus;
}

export interface BindingView extends LocalBinding {
  projectName: string;
  deviceLabel: string;
  repoPath: string | null;
  /** usable now: the computer is online, still has the repository, and its origin is the project's repository */
  valid: boolean;
  reason: string | null;
}

/**
 * Which repository on which computer belongs to which project (`<secretsDir>/local-agent-bindings.json`). A binding is only usable while the repository's `origin`
 * is the project's repository (`Project.repoUrl`): an agent of project A can never reach the repository of project B, whatever it is told.
 */
@Injectable()
export class LocalBindingsService {
  private store?: SecretJsonFile<LocalBinding[]>;

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly bridge: LocalBridgeService,
    private readonly devices: LocalDevicesService,
  ) {}

  private get file(): SecretJsonFile<LocalBinding[]> {
    return (this.store ??= new SecretJsonFile<LocalBinding[]>(join(this.config.secretsDir, 'local-agent-bindings.json'), {
      missing: [],
      pretty: true,
      parse: (raw) => {
        const list = (raw as { bindings?: unknown })?.bindings;
        return Array.isArray(list) ? (list.filter((b) => b && typeof b.id === 'string' && typeof b.projectId === 'string' && typeof b.deviceId === 'string' && typeof b.repoId === 'string') as LocalBinding[]) : [];
      },
    }));
  }

  list(): LocalBinding[] {
    return this.file.read();
  }

  private save(list: LocalBinding[]): void {
    this.file.write({ bindings: list } as never);
  }

  private async check(projectId: string, deviceId: string, repoId: string): Promise<{ ok: true; repo: RepoStatus; deviceLabel: string; projectName: string } | { ok: false; reason: string; projectName: string; deviceLabel: string; repoPath: string | null }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true, repoUrl: true, archivedAt: true } }).catch(() => null);
    const dev = this.devices.list().find((d) => d.id === deviceId);
    const base = { projectName: project?.name ?? '(deleted project)', deviceLabel: dev?.label ?? '(removed computer)' };
    if (!project || project.archivedAt) return { ok: false, reason: 'the project no longer exists', repoPath: null, ...base };
    if (!dev) return { ok: false, reason: 'the computer was disconnected', repoPath: null, ...base };
    if (!this.bridge.isOnline(deviceId)) return { ok: false, reason: 'the computer is offline', repoPath: null, ...base };
    const repo = this.bridge.repos(deviceId).find((r) => r.id === repoId);
    if (!repo) return { ok: false, reason: 'the repository is not allowed on that computer any more (aigentron add …)', repoPath: null, ...base };
    if (!project.repoUrl) return { ok: false, reason: 'the project has no repository address (Projects → settings → Repository), so the local one cannot be matched to it', repoPath: repo.path, ...base };
    if (!sameRemote(repo.origin, project.repoUrl)) return { ok: false, reason: `the repository's origin (${repo.origin || 'none'}) is not the project's repository`, repoPath: repo.path, ...base };
    return { ok: true, repo, ...base };
  }

  async create(input: { projectId: string; deviceId: string; repoId: string }, byUserId: string): Promise<{ ok: true; binding: LocalBinding } | { ok: false; error: string }> {
    const c = await this.check(input.projectId, input.deviceId, input.repoId);
    if (!c.ok) return { ok: false, error: c.reason.charAt(0).toUpperCase() + c.reason.slice(1) + '.' };
    const existing = this.list().find((b) => b.projectId === input.projectId && b.deviceId === input.deviceId && b.repoId === input.repoId);
    if (existing) return { ok: true, binding: existing };
    const binding: LocalBinding = { id: randomBytes(6).toString('hex'), ...input, createdAt: new Date().toISOString(), createdById: byUserId };
    this.save([...this.list().slice(-199), binding]);
    return { ok: true, binding };
  }

  remove(id: string): LocalBinding | null {
    const b = this.list().find((x) => x.id === id) ?? null;
    if (b) this.save(this.list().filter((x) => x.id !== id));
    return b;
  }

  /** A removed computer takes its bindings with it. */
  removeForDevice(deviceId: string): void {
    const all = this.list();
    if (all.some((b) => b.deviceId === deviceId)) this.save(all.filter((b) => b.deviceId !== deviceId));
  }

  /** Every binding with its live state (the dashboard). */
  async view(): Promise<BindingView[]> {
    const out: BindingView[] = [];
    for (const b of this.list()) {
      const c = await this.check(b.projectId, b.deviceId, b.repoId);
      out.push({ ...b, projectName: c.projectName, deviceLabel: c.deviceLabel, repoPath: c.ok ? c.repo.path : c.repoPath, valid: c.ok, reason: c.ok ? null : c.reason });
    }
    return out;
  }

  /** The usable bindings of one project (what an agent of that project may reach). */
  async resolveForProject(projectId: string): Promise<ResolvedBinding[]> {
    const out: ResolvedBinding[] = [];
    for (const b of this.list().filter((x) => x.projectId === projectId)) {
      const c = await this.check(b.projectId, b.deviceId, b.repoId);
      if (c.ok) out.push({ binding: b, deviceId: b.deviceId, deviceLabel: c.deviceLabel, repo: c.repo });
    }
    return out;
  }
}
