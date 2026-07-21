import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { AgentRegistryService } from './agent-registry.service';
import { AgentBodyDto, CreateAgentDto } from './dto/agent.dto';

function split(csv?: string): string[] | undefined {
  if (csv === undefined) return undefined;
  const list = csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function toDef(dto: AgentBodyDto) {
  return {
    description: dto.description,
    provider: dto.provider,
    fallbackProviders: split(dto.fallbackProviders),
    model: dto.model,
    skills: split(dto.skills),
    allowedTools: split(dto.allowedTools),
    disallowedTools: split(dto.disallowedTools),
    mcp: split(dto.mcp),
    instructions: dto.instructions,
  };
}

@Controller('agents')
export class AgentRegistryController {
  constructor(private readonly registry: AgentRegistryService) {}

  /** List available named agents (without their full instructions). */
  @Get()
  list() {
    return this.registry.list();
  }

  /** Skill names available to reference in an agent (declared before :name). */
  @Get('skills')
  skills() {
    return this.registry.listSkills();
  }

  /** Full agent definition (including instructions) for editing. */
  @Get(':name')
  get(@Param('name') name: string) {
    return this.registry.get(name);
  }

  @Post()
  create(@Body() dto: CreateAgentDto) {
    return this.registry.save(dto.name, toDef(dto));
  }

  @Put(':name')
  update(@Param('name') name: string, @Body() dto: AgentBodyDto) {
    return this.registry.save(name, toDef(dto));
  }

  @Delete(':name')
  async remove(@Param('name') name: string) {
    await this.registry.remove(name);
    return { name, deleted: true };
  }
}
