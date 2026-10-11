import { Body, Controller, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { TitlesService, type TitleConfig } from './titles.service';

/** Settings → Task titles. */
@Controller('titles')
export class TitlesController {
  constructor(private readonly titles: TitlesService) {}

  @Get()
  get() {
    return this.titles.get();
  }

  @Put()
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  set(@Body() body: Partial<TitleConfig>) {
    return this.titles.save(body ?? {});
  }

  @Post('test')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  test(@Body() body: { prompt?: string }) {
    return this.titles.test(String(body?.prompt ?? 'Сравни цены на датчик температуры DS18B20 у пяти поставщиков и составь таблицу'));
  }
}
