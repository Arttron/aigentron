import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma-sqlite/client';

/**
 * The `minimal`/single-container profile's storage driver (SQLite via the
 * better-sqlite3 driver adapter) — see docs/plan-single-container.md Phase 2.
 * Bound to the SAME `PrismaService` DI token as the Postgres driver
 * (prisma.module.ts), so none of its ~16 consumers change: they keep injecting
 * `PrismaService` and calling `this.prisma.task.findMany()` etc. unchanged.
 *
 * Schema note: prisma/sqlite/schema.prisma is GENERATED from prisma/schema.prisma
 * (enums -> String, the one scalar-list column -> a JSON string) because SQLite
 * supports neither. The real contract for those fields is the `@lds/shared`
 * union types the app already codes against — this class's generated TS types
 * are wider (e.g. `status: string` instead of a literal union) but the runtime
 * values are identical, since app code only ever writes the shared literals.
 */
@Injectable()
export class PrismaServiceSqlite extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaServiceSqlite.name);

  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url?.startsWith('file:')) {
      throw new Error('PrismaServiceSqlite requires a `file:`-scheme DATABASE_URL');
    }
    // better-sqlite3 takes a raw filesystem path, not the `file:` URL scheme.
    super({ adapter: new PrismaBetterSqlite3({ url: url.slice('file:'.length) }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to SQLite');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
