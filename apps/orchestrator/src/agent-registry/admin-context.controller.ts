import { BadRequestException, Body, Controller, Param, Put, UseGuards } from '@nestjs/common';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { AdminContextService } from './admin-context.service';
import { sanitizePage } from './admin-context-core';

/** The dashboard tells the admin chat which page the person is on (read by the admin's `current_context` tool). */
@Controller('admin-context')
@UseGuards(RolesGuard)
@Roles('operator', 'admin')
export class AdminContextController {
  constructor(private readonly context: AdminContextService) {}

  @Put(':taskId')
  set(@Param('taskId') taskId: string, @Body() body: unknown) {
    const page = sanitizePage(body);
    if (!page) throw new BadRequestException('path must be a dashboard path starting with "/"');
    this.context.set(taskId, page);
    return { ok: true };
  }
}
