import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/**
 * Read-only usage stats. PrismaService (global) supplies the data; the
 * RolesGuard (needs the global UsersService) gates the route. No extra imports.
 */
@Module({
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
