import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { SchedulesService, serializeSchedule, type ScheduleInput } from './schedules.service';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';
import { CurrentUser } from '../identity/current-user.decorator';
import type { UserRow } from '../users/users.service';

@Controller('schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  async list() {
    return (await this.schedules.list()).map(serializeSchedule);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async create(@Body() body: ScheduleInput, @CurrentUser() user: UserRow) {
    return serializeSchedule(await this.schedules.create(body, user?.displayName));
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async update(@Param('id') id: string, @Body() body: ScheduleInput) {
    return serializeSchedule(await this.schedules.update(id, body));
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async remove(@Param('id') id: string) {
    await this.schedules.remove(id);
    return { id, deleted: true };
  }

  /** Run it once now (to try it). */
  @Post(':id/run')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  run(@Param('id') id: string) {
    return this.schedules.runNow(id);
  }
}
