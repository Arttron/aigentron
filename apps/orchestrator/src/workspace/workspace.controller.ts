import { Controller, Delete, Get, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { serveFile } from '../files/file-io';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { ProjectsService } from '../projects/projects.service';
import { Workspace, WorkspaceService } from './workspace.service';

/**
 * The workspaces as a person sees them: browse, read, upload into work/, delete, edit the brief. `?project=<slug>` picks a project's own
 * folder (its brief is PROJECT.md); without it, the shared (default) workspace, as before.
 */
@Controller('workspace')
export class WorkspaceController {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly projects: ProjectsService,
  ) {}

  /** The workspace of a project (or the shared one). An unknown project is a 404 from the project lookup. */
  private async of(project?: string): Promise<Workspace> {
    const slug = (project ?? '').trim();
    if (!slug) return this.workspace;
    const ctx = await this.projects.contextFor(slug);
    return this.workspace.at(ctx.workspaceRoot, { briefFile: ctx.briefFile, briefTemplate: ctx.briefTemplate, project: ctx.isDefault ? null : { name: ctx.name, slug: ctx.slug } });
  }

  @Get()
  async summary(@Query('project') project?: string) {
    return (await this.of(project)).summary();
  }

  @Get('files')
  async list(@Query('path') path = '', @Query('project') project?: string) {
    const ws = await this.of(project);
    return { ...(await ws.list(path)), brief: ws.briefFile };
  }

  @Get('file')
  async file(@Query('path') path: string, @Query('download') download: string | undefined, @Query('project') project: string | undefined, @Req() req: Request, @Res() res: Response) {
    const f = await (await this.of(project)).fileForServing(path ?? '');
    // the shared policy: pictures, PDF, playable video (with byte ranges) and plain text render; everything else (html, svg, js …) downloads
    return serveFile(req, res, { path: f.abs, name: f.name, download: download === '1', cacheControl: 'private, no-cache' });
  }

  /** Raw body upload; allowed only in work/ (and the brief). */
  @Put('file')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async upload(@Query('path') path: string, @Query('project') project: string | undefined, @Req() req: Request) {
    return (await this.of(project)).writeUpload(path ?? '', req);
  }

  @Delete('file')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async remove(@Query('path') path: string, @Query('project') project?: string) {
    await (await this.of(project)).remove(path ?? '');
    return { ok: true };
  }
}
