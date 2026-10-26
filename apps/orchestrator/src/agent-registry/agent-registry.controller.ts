import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';
import { AgentRegistryService } from './agent-registry.service';
import { AgentCatalogService } from './agent-catalog.service';
import { AgentBundleService } from './agent-bundle.service';
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
    maxTurns: dto.maxTurns,
    instructions: dto.instructions,
  };
}

@Controller('agents')
export class AgentRegistryController {
  constructor(
    private readonly registry: AgentRegistryService,
    private readonly catalog: AgentCatalogService,
    private readonly bundles: AgentBundleService,
  ) {}

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

  /** Shipped agent templates (declared before :name) — starting points for the "+ New agent" form. */
  @Get('catalog')
  templates() {
    return this.catalog.list();
  }

  @Get('catalog/:name')
  template(@Param('name') name: string) {
    return this.catalog.getDef(name);
  }

  /** Import a bundle exported from another Aigentron (declared before :name). `dryRun` only plans. */
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  @Post('import')
  importBundle(@Body() body: { bundle: unknown; agentName?: string; overwrite?: string[]; dryRun?: boolean }) {
    return this.bundles.importBundle(body?.bundle, { agentName: body?.agentName, overwrite: body?.overwrite, dryRun: body?.dryRun });
  }

  /** Skills that can travel with an agent (the custom / learned ones). */
  @Get(':name/export-options')
  exportOptions(@Param('name') name: string) {
    return this.bundles.candidates(name);
  }

  /** The agent + its custom/learned skills as one JSON file; `learned` / `custom` (comma lists) add skills it does not list itself. */
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  @Get(':name/export')
  exportBundle(@Param('name') name: string, @Query('learned') learned?: string, @Query('custom') custom?: string) {
    return this.bundles.export(name, split(learned) ?? [], split(custom) ?? []);
  }

  /** Full agent definition (including instructions) for editing. */
  @Get(':name')
  get(@Param('name') name: string) {
    return this.registry.get(name);
  }

  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  @Post()
  create(@Body() dto: CreateAgentDto) {
    return this.registry.save(dto.name, toDef(dto));
  }

  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  @Put(':name')
  update(@Param('name') name: string, @Body() dto: AgentBodyDto) {
    return this.registry.save(name, toDef(dto));
  }

  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  @Delete(':name')
  async remove(@Param('name') name: string) {
    await this.registry.remove(name);
    return { name, deleted: true };
  }
}
