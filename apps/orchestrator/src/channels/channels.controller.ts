import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, Matches, MaxLength, Max, Min } from 'class-validator';
import { ChannelsService, type ChannelConfig } from './channels.service';
import { ChannelManagerService } from './channel-manager.service';
import { PairingService } from './pairing.service';
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

class ProbeSenderDto {
  @IsString()
  @MaxLength(20)
  kind!: string;

  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsObject()
  config?: ChannelConfig;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(25)
  waitSeconds?: number;
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
    private readonly pairing: PairingService,
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

  /**
   * "Find my id" (the add-channel form): wait up to `waitSeconds` for a message to the account in the form and answer who wrote what, so the person can
   * put their id on the allow-list. For a channel that is already RUNNING the bot's messages cannot be read twice: the chats that wrote to it and are not
   * allowed yet (the pairing list) are watched instead.
   */
  @Post('probe-sender')
  @HttpCode(200)
  async probeSender(@Body() dto: ProbeSenderDto) {
    const wait = dto.waitSeconds ?? 20;
    if (dto.id) {
      const row = await this.channels.getRow(dto.id);
      if (row.enabled && this.channels.isConfigured(row)) {
        const since = Date.now();
        for (;;) {
          const fresh = this.pairing.list(dto.id).find((p) => p.lastSeen >= since);
          if (fresh) return { found: true, chatId: fresh.chatId, userId: fresh.userId, userName: fresh.userName, text: fresh.firstText ?? '' };
          if (Date.now() - since >= wait * 1000) return { found: false };
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    return this.channels.probeSender(dto);
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

  /** Chats that wrote to the bot but are not allowed yet — approve one to let it in. */
  @Get(':id/pairings')
  async pairings(@Param('id') id: string) {
    await this.channels.getRow(id);
    return this.pairing.list(id).map((p) => ({ chatId: p.chatId, userName: p.userName ?? null, firstText: p.firstText ?? null, attempts: p.attempts, lastSeen: new Date(p.lastSeen).toISOString() }));
  }

  @Post(':id/pairings/:chatId/allow')
  async allow(@Param('id') id: string, @Param('chatId') chatId: string) {
    await this.channels.setChatAllowed(id, chatId, true);
    this.pairing.dismiss(id, chatId);
    await this.manager.onChatAllowed(id, chatId);
    return { id, chatId, allowed: true };
  }

  @Delete(':id/pairings/:chatId')
  async dismiss(@Param('id') id: string, @Param('chatId') chatId: string) {
    this.pairing.dismiss(id, chatId);
    return { id, chatId, dismissed: true };
  }

  @Post(':id/test')
  test(@Param('id') id: string) {
    return this.channels.test(id);
  }
}
