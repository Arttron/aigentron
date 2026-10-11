import { Body, Controller, Get, NotFoundException, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { imageMime, isImageName } from '../media/media-core';
import type { QuestionStatus } from '@lds/shared';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { CurrentUser } from '../identity/current-user.decorator';
import type { UserRow } from '../users/users.service';
import { QuestionsService } from './questions.service';

@Controller('questions')
export class QuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  @Get()
  list(@Query('status') status?: QuestionStatus, @Query('taskId') taskId?: string) {
    return this.questions.list(status, taskId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.questions.get(id);
  }

  /** The picture shown with a question (it was checked to be a real file of the task when the question was asked). */
  @Get(':id/image')
  async image(@Param('id') id: string, @Res() res: Response) {
    const q = await this.questions.get(id);
    if (!q.image || !isImageName(q.image)) throw new NotFoundException('This question has no picture.');
    res.setHeader('content-type', imageMime(q.image));
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'private, max-age=3600');
    res.sendFile(q.image, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }

  /** Answer: `{index}` for a tapped option, `{text}` for a typed answer. */
  @Post(':id/answer')
  @UseGuards(RolesGuard)
  @Roles('reviewer', 'operator', 'admin', 'task_setter')
  answer(@Param('id') id: string, @Body() body: { index?: number; indexes?: number[]; text?: string }, @CurrentUser() user: UserRow) {
    return this.questions.answer(id, { index: typeof body?.index === 'number' ? body.index : undefined, indexes: Array.isArray(body?.indexes) ? body.indexes.map(Number) : undefined, text: typeof body?.text === 'string' ? body.text : undefined }, { id: user.id, displayName: user.displayName });
  }
}
