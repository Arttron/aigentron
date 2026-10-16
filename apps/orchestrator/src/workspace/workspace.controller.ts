import { Controller, Delete, Get, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { serveFile } from '../files/file-io';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { WorkspaceService } from './workspace.service';

/** The shared workspace as a person sees it: browse, read, upload into work/, delete, edit the brief. */
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get()
  summary() {
    return this.workspace.summary();
  }

  @Get('files')
  list(@Query('path') path = '') {
    return this.workspace.list(path);
  }

  @Get('file')
  async file(@Query('path') path: string, @Query('download') download: string | undefined, @Req() req: Request, @Res() res: Response) {
    const f = await this.workspace.fileForServing(path ?? '');
    // the shared policy: pictures, PDF, playable video (with byte ranges) and plain text render; everything else (html, svg, js …) downloads
    return serveFile(req, res, { path: f.abs, name: f.name, download: download === '1', cacheControl: 'private, no-cache' });
  }

  /** Raw body upload; allowed only in work/ (and WORKSPACE.md). */
  @Put('file')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  upload(@Query('path') path: string, @Req() req: Request) {
    return this.workspace.writeUpload(path ?? '', req);
  }

  @Delete('file')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async remove(@Query('path') path: string) {
    await this.workspace.remove(path ?? '');
    return { ok: true };
  }
}
