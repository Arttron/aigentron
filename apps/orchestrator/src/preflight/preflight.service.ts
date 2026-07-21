import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';

/**
 * Boot-time safety checks. The headline one guards the documented footgun:
 * LiteLLM runs a DESTRUCTIVE prisma sync on startup that drops every table in
 * its database. If it were ever pointed at the orchestrator's DB it would wipe
 * all orchestrator data — so we fail loudly if the orchestrator is itself using
 * the `litellm` database, and warn if the separate `litellm` DB is missing.
 */
@Injectable()
export class PreflightService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PreflightService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Only relevant to the admin-API litellm driver sharing Postgres with the
    // orchestrator (docs/plan-single-container.md Phase 3) — the managed
    // driver (minimal profile) has no database of its own, and sqlite storage
    // makes the pg_database probe below meaningless either way.
    if (!this.config.litellmMasterKey || this.config.litellmManaged || this.config.storageDriver !== 'postgres') return;

    const orchDb = dbName(this.config.databaseUrl);
    if (orchDb === 'litellm') {
      throw new Error(
        "FATAL pre-flight: the orchestrator's DATABASE_URL points at the 'litellm' database. " +
          'LiteLLM drops every table in its DB on boot — the two MUST be separate. ' +
          'Point the orchestrator at its own database (e.g. `orchestrator`).',
      );
    }

    try {
      const rows = await this.prisma.$queryRawUnsafe<{ exists: boolean }[]>(
        `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = 'litellm') AS "exists"`,
      );
      if (rows?.[0]?.exists) {
        this.logger.log(`Pre-flight OK: orchestrator DB "${orchDb}" + a separate "litellm" DB present.`);
      } else {
        this.logger.warn(
          "LiteLLM is configured but no separate 'litellm' Postgres database exists. " +
            'LiteLLM needs its OWN database (it drops all tables in its DB on boot). ' +
            'Create it: `CREATE DATABASE litellm;` (see infra/postgres-init/01-create-litellm-db.sql).',
        );
      }
    } catch (e) {
      // Never block boot on the *check* failing (e.g. missing catalog perms).
      this.logger.warn(`Pre-flight DB check skipped: ${(e as Error).message}`);
    }
  }
}

/** Database name from a postgres connection URL (null if unparseable). */
function dbName(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/^\//, '');
    return path.split('/')[0] || null;
  } catch {
    return null;
  }
}
