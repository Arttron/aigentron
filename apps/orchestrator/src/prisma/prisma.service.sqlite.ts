import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma-sqlite/client';

/** How long a connection waits for a locked database before SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 10_000;

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
    // `timeout` = SQLite's busy_timeout for this connection: with the concurrency > 1
    // worker and an external writer (a backup, the CLI) a locked database waits
    // instead of failing with SQLITE_BUSY (X-DB-6).
    super({ adapter: new PrismaBetterSqlite3({ url: url.slice('file:'.length), timeout: BUSY_TIMEOUT_MS }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.tune();
    this.logger.log('Connected to SQLite');
  }

  /**
   * Journal settings for a server workload (X-DB-6): WAL lets readers run while a
   * write is in progress (the dashboard polls while agents stream events) and
   * survives a crash without a rollback journal; it is persistent in the file, so
   * the CLI / migrations see it too. busy_timeout is per connection — set here as
   * well as via the driver option, so it holds whichever way the adapter connects.
   */
  private async tune(): Promise<void> {
    try {
      const [{ journal_mode }] = await this.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode = WAL');
      await this.$queryRawUnsafe(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      // NORMAL under WAL: durable across a process crash, only an OS crash can lose the last transactions; far fewer fsyncs.
      await this.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
      await this.$queryRawUnsafe('PRAGMA foreign_keys = ON');
      if (journal_mode?.toLowerCase() !== 'wal') this.logger.warn(`SQLite journal_mode is ${journal_mode}, not WAL (a network filesystem?)`);
    } catch (err) {
      this.logger.warn(`Could not apply the SQLite journal settings: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
