import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { IsObject, IsString, Matches, MaxLength } from 'class-validator';
import { McpService, type McpConfig } from './mcp.service';

class CreateMcpDto {
  @IsString()
  @Matches(/^[\w-]+$/, { message: 'name must be alphanumeric/dash/underscore' })
  @MaxLength(60)
  name!: string;

  @IsObject()
  config!: McpConfig;
}

class UpdateMcpDto {
  @IsObject()
  config!: McpConfig;
}

/**
 * An MCP server config is a COMMAND the orchestrator host runs (stdio) — creating, changing or "discovering" one is code execution,
 * so everything that is not a plain read needs operator/admin.
 */
@Controller('mcp-servers')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Get()
  list() {
    return this.mcp.list();
  }

  /** Connects to the server and refreshes its read-only tool list from the tools' annotations. */
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  @Post(':name/discover')
  discover(@Param('name') name: string) {
    return this.mcp.discover(name);
  }

  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  @Post()
  create(@Body() dto: CreateMcpDto) {
    return this.mcp.create(dto.name, dto.config);
  }

  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  @Put(':name')
  update(@Param('name') name: string, @Body() dto: UpdateMcpDto) {
    return this.mcp.update(name, dto.config);
  }

  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  @Delete(':name')
  async remove(@Param('name') name: string) {
    await this.mcp.remove(name);
    return { name, deleted: true };
  }
}
