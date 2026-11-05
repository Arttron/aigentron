import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { DiskMonitorService } from './disk-monitor.service';
import { FinishedWorkService } from './finished-work.service';
import { MaintenanceService, type CleanupRequest, type CleanupResult, type MaintenanceReport } from './maintenance.service';

@Controller('maintenance')
@UseGuards(RolesGuard)
@Roles('operator', 'admin')
export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly disk: DiskMonitorService,
    private readonly finished: FinishedWorkService,
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

  /** The checkouts of tasks and what the cleanup policy would do with each (nothing is touched). */
  @Get('finished-work')
  finishedWork() {
    return this.finished.plan();
  }

  /** Clear the checkouts the policy allows now (the same thing the 6-hourly sweep does). */
  @Post('finished-work/run')
  runFinishedWork() {
    return this.finished.sweep();
  }

  /** What was cleared lately. */
  @Get('finished-work/log')
  finishedWorkLog() {
    return this.finished.log();
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
