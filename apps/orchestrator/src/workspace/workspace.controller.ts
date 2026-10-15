import { Controller, Delete, Get, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { pipeFile } from '../media/pipe-file';
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
  async file(@Query('path') path: string, @Query('download') download: string | undefined, @Res() res: Response) {
    const f = await this.workspace.fileForServing(path ?? '');
    res.setHeader('content-type', f.mime);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'private, no-cache');
    // Only images, PDF and plain text render in the browser; everything else (html, svg, js …) downloads — it must never run as same-origin script.
    if (!f.inline || download === '1') res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.setHeader('content-length', String(f.size));
    pipeFile(res, f.abs);
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
