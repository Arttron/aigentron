import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto, UpdateProjectDto } from './dto/project.dto';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';
import { CurrentUser } from '../identity/current-user.decorator';
import type { UserRow } from '../users/users.service';

/**
 * Projects (docs/plan-projects-workspace.md §2.8). Reading is open to every signed-in role; creating, changing,
 * archiving and deleting are for operators and admins. Responses never carry a secret (repository tokens are
 * files in the secrets dir, not fields).
 */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  /** All projects; `?archived=1` includes the archived ones. */
  @Get()
  async list(@Query('archived') archived?: string) {
    const rows = await this.projects.list({ includeArchived: /^(1|true|yes)$/i.test(archived ?? '') });
    return this.projects.serializeAll(rows);
  }

  @Get(':slug')
  async get(@Param('slug') slug: string) {
    return this.projects.serialize(await this.projects.get(slug));
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async create(@Body() dto: CreateProjectDto, @CurrentUser() user: UserRow) {
    return this.projects.serialize(await this.projects.create(dto, user?.id));
  }

  @Patch(':slug')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async update(@Param('slug') slug: string, @Body() dto: UpdateProjectDto) {
    const { archived, ...patch } = dto;
    let row = await this.projects.update(slug, patch);
    if (archived === false) row = await this.projects.unarchive(slug);
    else if (archived === true) row = await this.projects.archive(slug);
    return this.projects.serialize(row);
  }

  @Post(':slug/archive')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async archive(@Param('slug') slug: string) {
    return this.projects.serialize(await this.projects.archive(slug));
  }

  @Delete(':slug')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async remove(@Param('slug') slug: string) {
    const r = await this.projects.remove(slug);
    return { ...r, deleted: true };
  }
}
