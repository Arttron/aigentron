import { getHold } from '../queue/holds';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { FollowUpDto } from './dto/follow-up.dto';
import { ListTasksDto } from './dto/list-tasks.dto';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';
import { CurrentUser } from '../identity/current-user.decorator';
import type { UserRow } from '../users/users.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  create(@Body() dto: CreateTaskDto, @CurrentUser() user: UserRow) {
    return this.tasks.create(dto, user.id);
  }

  @Get()
  list(@Query() dto: ListTasksDto) {
    return this.tasks.list(dto);
  }

  /** Counts per task type (the filter chips). */
  @Get('type-counts')
  typeCounts() {
    return this.tasks.typeCounts();
  }

  /** Counts per status (the status chips), optionally within one `type`. */
  @Get('status-counts')
  statusCounts(@Query('type') type?: string) {
    return this.tasks.statusCounts(type);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    // `hold`: why a queued task has not started yet (the machine is busy / its turn), or null
    return { ...(await this.tasks.get(id)), hold: getHold(id) };
  }

  @Get(':id/transcript')
  transcript(@Param('id') id: string) {
    return this.tasks.transcript(id);
  }

  /** Queue a task created with autostart=false (after its attachments upload). */
  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  @Post(':id/start')
  start(@Param('id') id: string, @Body() dto: FollowUpDto) {
    return this.tasks.start(id, dto.attachments);
  }

  /** The person accepts the task as finished (`review` / `blocked` / `stalled` / `failed` → `done`). */
  @Post(':id/done')
  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  done(@Param('id') id: string, @Body() body?: { cancelOpenSubtasks?: boolean }) {
    return this.tasks.markDone(id, { cancelOpenSubtasks: body?.cancelOpenSubtasks === true });
  }

  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  @Post(':id/follow-up')
  followUp(@Param('id') id: string, @Body() dto: FollowUpDto) {
    return this.tasks.followUp(id, dto.prompt ?? '', dto.attachments, dto.references);
  }

  /** Move a (settled) subtask out of its lead to the top level of the same project. */
  @Post(':id/promote')
  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  promote(@Param('id') id: string) {
    return this.tasks.promoteToRoot(id);
  }

  /** The task's pending-follow-up queue (messages held while it's still running). */
  @Get(':id/pending-follow-ups')
  listPendingFollowUps(@Param('id') id: string) {
    return this.tasks.listPendingFollowUps(id);
  }

  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  @Patch(':id/pending-follow-ups/:pendingId')
  updatePendingFollowUp(
    @Param('id') id: string,
    @Param('pendingId') pendingId: string,
    @Body() dto: FollowUpDto,
  ) {
    return this.tasks.updatePendingFollowUp(id, pendingId, {
      text: dto.prompt,
      attachments: dto.attachments,
      references: dto.references,
    });
  }

  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  @Delete(':id/pending-follow-ups/:pendingId')
  removePendingFollowUp(@Param('id') id: string, @Param('pendingId') pendingId: string) {
    return this.tasks.removePendingFollowUp(id, pendingId);
  }

  /** Create + enqueue a subtask under this task (manual decomposition). */
  @Post(':id/subtasks')
  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  createSubtask(
    @Param('id') id: string,
    @Body() dto: CreateTaskDto,
    @CurrentUser() user: UserRow,
  ) {
    return this.tasks.createSubtask(
      id,
      { prompt: dto.prompt, title: dto.title, agentName: dto.agentName },
      user.id,
    );
  }

  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.tasks.cancel(id);
  }

  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.tasks.delete(id);
  }
}
