import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
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

  @Get(':id')
  get(@Param('id') id: string) {
    return this.tasks.get(id);
  }

  @Get(':id/transcript')
  transcript(@Param('id') id: string) {
    return this.tasks.transcript(id);
  }

  /** Queue a task created with autostart=false (after its attachments upload). */
  @Post(':id/start')
  start(@Param('id') id: string, @Body() dto: FollowUpDto) {
    return this.tasks.start(id, dto.attachments);
  }

  @Post(':id/follow-up')
  followUp(@Param('id') id: string, @Body() dto: FollowUpDto) {
    return this.tasks.followUp(id, dto.prompt ?? '', dto.attachments, dto.references);
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

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.tasks.cancel(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.tasks.delete(id);
  }
}
