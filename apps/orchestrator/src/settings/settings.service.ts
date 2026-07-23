import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';

const SINGLETON_ID = 'singleton';

/** Prisma row shape for the settings singleton. */
type SettingsRow = NonNullable<Awaited<ReturnType<PrismaService['appSettings']['findUnique']>>>;

/** Fields a client may patch via PUT /api/settings. */
export interface SettingsPatch {
  approvalTimeoutSeconds?: number;
  verifyCommands?: string | null;
  verifyMaxAttempts?: number;
  debugMode?: boolean;
  agentInstructions?: string;
  repoUrl?: string | null;
  repoBranch?: string;
  githubToken?: string | null;
  workspaceSubdir?: string | null;
  defaultProvider?: string | null;
  defaultAgent?: string | null;
  notifyChannelId?: string | null;
  notifyChatId?: string | null;
}

/** Source-repository configuration for the workspace provisioner. */
export interface WorkspaceConfig {
  repoUrl: string | null;
  repoBranch: string;
  githubToken: string | null;
}

/**
 * Runtime configuration store. Seeded from environment on first use, then the
 * DB row is authoritative — the orchestrator reads it at agent-spawn time, so
 * the dashboard can change routing/keys without recreating the container.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /** Load the singleton, seeding from environment defaults on first call. */
  async load(): Promise<SettingsRow> {
    const existing = await this.prisma.appSettings.findUnique({ where: { id: SINGLETON_ID } });
    if (existing) return existing;

    // Atomic seed: an `upsert` keyed on the singleton id can't lose a race to a
    // concurrent first caller (two creates would collide on the unique id).
    const seeded = await this.prisma.appSettings.upsert({
      where: { id: SINGLETON_ID },
      update: {},
      create: {
        id: SINGLETON_ID,
        approvalTimeoutSeconds: this.config.approvalTimeoutSeconds,
        repoUrl: cleanEnv(process.env.REPO_URL),
        repoBranch: process.env.REPO_BRANCH?.trim() || 'main',
        githubToken: cleanEnv(process.env.GITHUB_TOKEN),
        defaultProvider: 'ollama-local',
      },
    });
    this.logger.log('Seeded AppSettings from environment');
    return seeded;
  }

  get(): Promise<SettingsRow> {
    return this.load();
  }

  async update(patch: SettingsPatch): Promise<SettingsRow> {
    await this.load(); // ensure the row exists
    const updated = await this.prisma.appSettings.update({
      where: { id: SINGLETON_ID },
      data: patch,
    });
    this.logger.log('Settings updated');
    return updated;
  }

  async approvalTimeoutSeconds(): Promise<number> {
    return (await this.load()).approvalTimeoutSeconds;
  }

  /**
   * Internal-only (not part of SettingsPatch / the public PATCH endpoint) —
   * SkillConsolidationSchedulerService stamps this after scheduling a review,
   * a human never sets it directly.
   */
  async markSkillConsolidationRun(): Promise<void> {
    await this.load();
    await this.prisma.appSettings.update({
      where: { id: SINGLETON_ID },
      data: { lastSkillConsolidationAt: new Date() },
    });
  }

  /** Verification commands (one per line) run in the worktree after a run. */
  async verifyCommands(): Promise<string[]> {
    return ((await this.load()).verifyCommands ?? '')
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean);
  }

  async verifyMaxAttempts(): Promise<number> {
    return (await this.load()).verifyMaxAttempts;
  }

  /** Whether to persist verbose intermediate transcript events (see AgentEvent). */
  async debugMode(): Promise<boolean> {
    return (await this.load()).debugMode;
  }

  /** Instructions appended to the agent's system prompt (the "skill"). */
  async agentInstructions(): Promise<string> {
    return (await this.load()).agentInstructions;
  }

  /** Provider name used for tasks that don't select an agent. */
  async defaultProvider(): Promise<string> {
    return (await this.load()).defaultProvider ?? 'ollama-local';
  }

  /** Named agent used as the lead for tasks that don't pick one (e.g. pm). */
  async defaultAgent(): Promise<string | null> {
    return (await this.load()).defaultAgent ?? null;
  }

  /** Source-repository config for the workspace provisioner. */
  async workspaceConfig(): Promise<WorkspaceConfig> {
    const s = await this.load();
    return {
      repoUrl: s.repoUrl ?? null,
      repoBranch: s.repoBranch,
      githubToken: s.githubToken ?? null,
    };
  }

  /** Normalized project subdirectory ('' = repo root). */
  async workspaceSubdir(): Promise<string> {
    return normalizeSubdir((await this.load()).workspaceSubdir);
  }

  /**
   * Effective working directory (cwd) for a task's worktree: the worktree root
   * joined with the configured subdirectory. Falls back to the worktree root if
   * no subdir is set or the subdir doesn't exist in this worktree (so a stale
   * config can't wedge every task) — the caller keeps the worktree root as the
   * write boundary regardless.
   */
  async workDir(worktreePath: string): Promise<string> {
    const sub = await this.workspaceSubdir();
    if (!sub) return worktreePath;
    const dir = join(worktreePath, sub);
    try {
      if ((await stat(dir)).isDirectory()) return dir;
      this.logger.warn(`workspaceSubdir "${sub}" is not a directory — using worktree root`);
    } catch {
      this.logger.warn(`workspaceSubdir "${sub}" not found in worktree — using worktree root`);
    }
    return worktreePath;
  }
}

/**
 * Normalize a configured project subdir to a safe relative path. Strips leading/
 * trailing slashes and rejects absolute paths or any `..` traversal (→ '' = root)
 * so it can never escape the worktree.
 */
function normalizeSubdir(raw?: string | null): string {
  const v = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!v) return '';
  if (v.split('/').some((seg) => seg === '..' || seg === '.')) return '';
  return v;
}

/** Drop empty / obvious-placeholder env values so they don't seed as real. */
function cleanEnv(value?: string): string | null {
  const v = value?.trim();
  if (!v || v.includes('xxx') || v.includes('<') || v.includes('your-')) return null;
  return v;
}
