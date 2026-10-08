import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { MaintenanceService, type CleanupRequest, type CleanupResult, type MaintenanceReport } from './maintenance.service';

@Controller('maintenance')
@UseGuards(RolesGuard)
@Roles('operator', 'admin')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

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
