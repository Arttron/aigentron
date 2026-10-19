import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { DEFAULT_PROJECT_ID, normalizeSubdir } from '../projects/project-core';

const SINGLETON_ID = 'singleton';

/** Prisma row shape for the settings singleton. */
type SettingsRow = NonNullable<Awaited<ReturnType<PrismaService['appSettings']['findUnique']>>>;

/** Fields a client may patch via PUT /api/settings. */
export interface SettingsPatch {
  approvalTimeoutSeconds?: number;
  verifyCommands?: string | null;
  verifyMaxAttempts?: number;
  concurrency?: number;
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

/**
 * How long a loaded row is served from memory (E-10). Every accessor used to be
 * a `findUnique`: ≈ 8 queries at the start of one run plus the worker's poll
 * every 10 s. Writes through this service refresh the cache at once; a write by
 * ANOTHER instance (full profile with several orchestrators) is seen within
 * this window.
 */
const CACHE_TTL_MS = 3000;

/**
 * Runtime configuration store. Seeded from environment on first use, then the
 * DB row is authoritative — the orchestrator reads it at agent-spawn time, so
 * the dashboard can change routing/keys without recreating the container.
 *
 * Projects (round 1): the repository, subdirectory, verify and escalation fields of this row are the DEFAULT
 * project's — the runtime reads them from the Project row (ProjectsService.contextFor), never from here. A write
 * through this service (Settings → General, the admin's propose_settings) is mirrored into the default project so
 * the legacy screen keeps working until it points at the project itself. The GitHub token stays here only until
 * GitAccessService migrates it into the default project's secret file (it reads it as the fallback meanwhile).
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache: { row: SettingsRow; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /** Load the singleton (served from memory for a few seconds), seeding from environment defaults on first call. */
  async load(): Promise<SettingsRow> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.row;
    const row = await this.loadFresh();
    this.cache = { row, at: Date.now() };
    return row;
  }

  /** Forget the cached row (the next accessor reads the DB). */
  invalidate(): void {
    this.cache = null;
  }

  private async loadFresh(): Promise<SettingsRow> {
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
        concurrency: this.config.agentConcurrency,
        repoUrl: cleanEnv(process.env.REPO_URL),
        repoBranch: process.env.REPO_BRANCH?.trim() || 'main',
        githubToken: cleanEnv(process.env.GITHUB_TOKEN),
        defaultProvider: 'ollama-local',
        // Fresh installs start with only the built-in admin agent; existing
        // rows keep whatever default they already have.
        defaultAgent: 'admin',
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
    this.cache = { row: updated, at: Date.now() };
    this.logger.log('Settings updated');
    await this.mirrorToDefaultProject(patch);
    return updated;
  }

  /** The legacy repository / verify / escalation fields are the default project's: keep its row in step (see the class doc). */
  private async mirrorToDefaultProject(patch: SettingsPatch): Promise<void> {
    const data = defaultProjectPatch(patch);
    if (!Object.keys(data).length) return;
    await this.prisma.project
      .updateMany({ where: { id: DEFAULT_PROJECT_ID }, data })
      .catch((err) => this.logger.warn(`could not mirror the settings into the default project: ${(err as Error).message}`));
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
    const updated = await this.prisma.appSettings.update({
      where: { id: SINGLETON_ID },
      data: { lastSkillConsolidationAt: new Date() },
    });
    this.cache = { row: updated, at: Date.now() };
  }

  /**
   * Max agent runs processed in parallel — polled live by the queue worker. The cap for ALL projects together;
   * tasks of one shared-mode project take turns in its checkout through the worker's per-project lock, so the
   * value no longer has to be 1 in shared mode (it still is, by the seed, until a person raises it).
   */
  async concurrency(): Promise<number> {
    return Math.max(1, (await this.load()).concurrency);
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

  /** Named agent used as the lead for tasks that don't pick one (e.g. pm) — the global fallback behind `Project.defaultAgent`. */
  async defaultAgent(): Promise<string | null> {
    return (await this.load()).defaultAgent ?? null;
  }

  /** The installation's GitHub token (Settings → General): the transitional git credential and the GitHub MCP / PR API token. */
  async githubToken(): Promise<string | null> {
    return (await this.load()).githubToken ?? null;
  }
}

/** The default project's columns a legacy settings patch maps to (only the keys present in the patch). */
export function defaultProjectPatch(patch: SettingsPatch): Record<string, string | number | null> {
  const data: Record<string, string | number | null> = {};
  if ('repoUrl' in patch) data.repoUrl = patch.repoUrl?.trim() || null;
  if (patch.repoBranch !== undefined && patch.repoBranch.trim()) data.repoBranch = patch.repoBranch.trim();
  if ('workspaceSubdir' in patch) data.repoSubdir = normalizeSubdir(patch.workspaceSubdir) || null;
  if ('githubToken' in patch) data.repoAuth = patch.githubToken ? 'token' : 'none';
  if ('verifyCommands' in patch) data.verifyCommands = patch.verifyCommands?.replace(/\r/g, '').trim() || null;
  if (patch.verifyMaxAttempts !== undefined && Number.isInteger(patch.verifyMaxAttempts)) data.verifyMaxAttempts = patch.verifyMaxAttempts;
  if ('defaultAgent' in patch) data.defaultAgent = patch.defaultAgent?.trim() || null;
  if ('notifyChannelId' in patch) data.notifyChannelId = patch.notifyChannelId?.trim() || null;
  if ('notifyChatId' in patch) data.notifyChatId = patch.notifyChatId?.trim() || null;
  return data;
}

/** Drop empty / obvious-placeholder env values so they don't seed as real. */
function cleanEnv(value?: string): string | null {
  const v = value?.trim();
  if (!v || v.includes('xxx') || v.includes('<') || v.includes('your-')) return null;
  return v;
}
