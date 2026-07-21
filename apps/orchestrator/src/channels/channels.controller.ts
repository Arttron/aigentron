import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ChannelsService, type ChannelConfig } from './channels.service';
import { ChannelManagerService } from './channel-manager.service';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';

class CreateChannelDto {
  @IsString()
  @Matches(/^[\w-]+$/, { message: 'name must be alphanumeric/dash/underscore' })
  @MaxLength(60)
  name!: string;

  @IsString()
  @MaxLength(20)
  kind!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  config?: ChannelConfig;
}

class UpdateChannelDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  config?: ChannelConfig;
}

@Controller('channels')
@UseGuards(RolesGuard)
@Roles('operator', 'admin')
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly manager: ChannelManagerService,
  ) {}

  /** Kind metadata for the add/edit picker + dynamic form. */
  @Get('kinds')
  kinds() {
    return this.channels.kinds();
  }

  @Get()
  async list() {
    const rows = await this.channels.list();
    return rows.map((r) => this.channels.serialize(r));
  }

  @Post()
  async create(@Body() dto: CreateChannelDto) {
    const row = await this.channels.create(dto);
    await this.manager.reload();
    return this.channels.serialize(row);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateChannelDto) {
    const row = await this.channels.update(id, dto);
    await this.manager.reload();
    return this.channels.serialize(row);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.channels.remove(id);
    await this.manager.reload();
    return { id, deleted: true };
  }

  @Post(':id/test')
  test(@Param('id') id: string) {
    return this.channels.test(id);
  }
}
