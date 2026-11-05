import { Module } from '@nestjs/common';
import { MaintenanceController } from './maintenance.controller';
import { DiskMonitorService } from './disk-monitor.service';
import { FinishedWorkService } from './finished-work.service';
import { MaintenanceService } from './maintenance.service';

@Module({
  controllers: [MaintenanceController],
  providers: [MaintenanceService, DiskMonitorService, FinishedWorkService],
  exports: [MaintenanceService, DiskMonitorService, FinishedWorkService],
})
export class MaintenanceModule {}
