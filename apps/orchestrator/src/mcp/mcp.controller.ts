import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
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

@Controller('mcp-servers')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Get()
  list() {
    return this.mcp.list();
  }

  @Post()
  create(@Body() dto: CreateMcpDto) {
    return this.mcp.create(dto.name, dto.config);
  }

  @Put(':name')
  update(@Param('name') name: string, @Body() dto: UpdateMcpDto) {
    return this.mcp.update(name, dto.config);
  }

  @Delete(':name')
  async remove(@Param('name') name: string) {
    await this.mcp.remove(name);
    return { name, deleted: true };
  }
}
