import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { CurrentUser } from '../identity/current-user.decorator';
import type { UserRow } from '../users/users.service';
import { DiscussionService } from './discussion.service';

/** Round-table discussions between agents inside a chat (task). */
@Controller('discussions')
export class DiscussionController {
  constructor(private readonly discussions: DiscussionService) {}

  /** Start one — in an existing chat (`taskId`) or in a new one. */
  @Post()
  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  start(@Body() body: { taskId?: string; topic?: string; agents?: string[]; rounds?: number; summaryBy?: string | null }, @CurrentUser() user: UserRow) {
    return this.discussions.start({ ...body, createdById: user.id });
  }

  @Get(':taskId')
  state(@Param('taskId') taskId: string) {
    return this.discussions.state(taskId);
  }

  @Post(':taskId/conclude')
  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  conclude(@Param('taskId') taskId: string) {
    return this.discussions.conclude(taskId);
  }

  @Post(':taskId/stop')
  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  stop(@Param('taskId') taskId: string) {
    return this.discussions.stop(taskId);
  }
}
