import * as dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

// Load local/root .env for CLI commands (migrate/deploy). In Docker the env is
// injected directly, so a missing file is fine.
dotenv.config({ path: ['.env', '../../.env'] });

/**
 * Prisma 7 config. The connection URL lives here (no longer in schema.prisma)
 * and is consumed by the CLI for `migrate`/`db`. The runtime client connects
 * via the @prisma/adapter-pg driver adapter (see prisma.service.ts).
 *
 * A placeholder fallback keeps `prisma generate` (run during the build, which
 * needs no DB) working even when DATABASE_URL is absent. Real `migrate`/`deploy`
 * commands run with a real DATABASE_URL in the environment.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://placeholder@localhost:5432/placeholder',
  },
});
