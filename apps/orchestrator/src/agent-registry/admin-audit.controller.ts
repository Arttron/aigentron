import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { AdminAuditService } from './admin-audit.service';

/** Read-only view of the admin's change journal (used by the approval cards and the console). */
@Controller('admin-audit')
@UseGuards(RolesGuard)
@Roles('operator', 'admin')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    return this.audit.list(limit ? Number(limit) : 20);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const e = await this.audit.get(id);
    if (!e) throw new NotFoundException(`No admin change ${id}`);
    return e;
  }
}
