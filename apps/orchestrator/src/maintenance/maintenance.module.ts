import { Module } from '@nestjs/common';
import { MaintenanceController } from './maintenance.controller';
import { DiskMonitorService } from './disk-monitor.service';
import { MaintenanceService } from './maintenance.service';

@Module({
  controllers: [MaintenanceController],
  providers: [MaintenanceService, DiskMonitorService],
  exports: [MaintenanceService, DiskMonitorService],
})
export class MaintenanceModule {}
