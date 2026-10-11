import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { DiskMonitorService } from './disk-monitor.service';
import { MaintenanceService, type CleanupRequest, type CleanupResult, type MaintenanceReport } from './maintenance.service';

@Controller('maintenance')
@UseGuards(RolesGuard)
@Roles('operator', 'admin')
export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly disk: DiskMonitorService,
  ) {}

  /** Free space of the data disk and its level (ok / warn / critical). */
  @Get('disk')
  diskStatus() {
    return this.disk.status();
  }

  /** The safe "free space now" action: all digest caches, fetched pages older than 30 days, run folders older than 3 days. */
  @Post('relieve')
  relieve() {
    return this.maintenance.relieve();
  }

  @Get('report')
  report(): Promise<MaintenanceReport> {
    return this.maintenance.report();
  }

  /** Dry run by default — pass `"dryRun": false` to actually delete. */
  @Post('cleanup')
  cleanup(@Body() body: CleanupRequest): Promise<CleanupResult> {
    return this.maintenance.cleanup(body ?? {});
  }
}
