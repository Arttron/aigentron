import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from './prisma.service';
import { PrismaServiceSqlite } from './prisma.service.sqlite';

/**
 * Storage module (docs/plan-single-container.md Phase 2). Binds BOTH storage
 * drivers to the same `PrismaService` token, picked by `AppConfigService.
 * storageDriver` (itself derived from the DATABASE_URL scheme) — so the ~16
 * consumers across the app keep injecting `PrismaService` unchanged regardless
 * of which profile is running. The Postgres path (the default/full profile) is
 * untouched — it's the regression baseline.
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      inject: [AppConfigService],
      // The sqlite driver's generated types are wider (enums -> string, one
      // scalar-list column -> a JSON string; see prisma.service.sqlite.ts) —
      // this single cast is the one place that tradeoff is made explicit.
      useFactory: (config: AppConfigService) =>
        (config.storageDriver === 'sqlite' ? new PrismaServiceSqlite() : new PrismaService()) as PrismaService,
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
