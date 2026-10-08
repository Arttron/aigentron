import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { PacksService, describeReport } from './packs.service';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';
import { CurrentUser } from '../identity/current-user.decorator';
import type { UserRow } from '../users/users.service';

@Controller('packs')
export class PacksController {
  constructor(private readonly packs: PacksService) {}

  @Get()
  list() {
    return this.packs.list();
  }

  @Get(':name')
  get(@Param('name') name: string) {
    return this.packs.info(name);
  }

  /** Install a pack. Never overwrites what already exists; schedules arrive switched off. */
  @Post(':name/install')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async install(@Param('name') name: string, @Body() body: { timezone?: string }, @CurrentUser() user: UserRow) {
    const report = await this.packs.install(name, { timezone: body?.timezone, by: user?.displayName });
    return { ...report, summary: describeReport(report) };
  }
}
