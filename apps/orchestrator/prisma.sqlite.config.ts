import * as dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

// Load local/root .env for CLI commands (migrate/deploy). In Docker the env is
// injected directly, so a missing file is fine.
dotenv.config({ path: ['.env', '../../.env'] });

/**
 * Prisma 7 config for the SQLITE variant (minimal/single-container profile —
 * docs/plan-single-container.md Phase 2). Sibling of prisma.config.ts (the
 * postgres/full-profile config, unchanged); this one points the CLI at the
 * generated prisma/sqlite/schema.prisma and its own migration history so the
 * two datasources never share migration state.
 *
 * DATABASE_URL doubles as the source for BOTH configs — the runtime
 * (AppConfigService.storageDriver) and this file pick sqlite by the same
 * `file:` scheme check, so `prisma migrate deploy --config prisma.sqlite.config.ts`
 * only makes sense (and is only invoked) when DATABASE_URL is a sqlite URL.
 */
export default defineConfig({
  schema: 'prisma/sqlite/schema.prisma',
  migrations: {
    path: 'prisma/sqlite/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'file:./placeholder.db',
  },
});
