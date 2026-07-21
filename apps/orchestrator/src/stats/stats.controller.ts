import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { UsageReport } from '@lds/shared';
import { StatsService } from './stats.service';
import { UsageQueryDto } from './dto/stats.dto';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';

@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  /** Per-provider token / request / cost usage over an optional [from, to] range. */
  @Get('usage')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  usage(@Query() q: UsageQueryDto): Promise<UsageReport> {
    return this.stats.usageByProvider({
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
  }
}
