import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { TitlesService } from './titles.service';

/** "🌐 Translate" under a message (on demand — never automatic, it costs a few tokens). */
@Controller('translate')
export class TranslateController {
  constructor(private readonly titles: TitlesService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('reviewer', 'task_setter', 'operator', 'admin')
  translate(@Body() body: { text?: string; to?: string }) {
    return this.titles.translate(String(body?.text ?? ''), String(body?.to ?? ''));
  }
}
