import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { serveFile } from '../files/file-io';
import { ResourcesService } from './resources.service';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';

@Controller('resources')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get()
  async list() {
    return { items: await this.resources.list(), usage: await this.resources.usage() };
  }

  /** A note written in the dashboard (Markdown). */
  @Post()
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  createNote(@Body() body: { title?: string; description?: string; tags?: unknown; agents?: unknown; text?: string }) {
    return this.resources.createNote({ ...body, text: String(body?.text ?? '') });
  }

  /**
   * Upload one file as the raw body (send `content-type: application/octet-stream` and the name in `x-filename`, URL-encoded).
   * Title / description / tags can be given as headers or edited afterwards.
   */
  @Post('upload')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  upload(@Req() req: Request) {
    const dec = (h: string) => {
      const v = req.header(h);
      try {
        return v ? decodeURIComponent(v) : undefined;
      } catch {
        throw new BadRequestException(`The ${h} header is not valid (it must be URL-encoded).`);
      }
    };
    return this.resources.upload(dec('x-filename') ?? 'upload', req, { title: dec('x-title'), description: dec('x-description'), tags: dec('x-tags') }, Number(req.header('content-length')) > 0 ? Number(req.header('content-length')) : undefined);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const r = await this.resources.get(id);
    return { ...r, text: r.kind === 'text' ? await this.resources.text(id) : undefined };
  }

  @Get(':id/file')
  async file(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const r = await this.resources.get(id);
    // the shared policy: pictures / PDF / playable video inline, text as text/plain, everything else downloads under its original name
    return serveFile(req, res, { path: this.resources.pathOf(r), name: r.originalName, cacheControl: 'private, max-age=60' });
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  update(@Param('id') id: string, @Body() body: { title?: string; description?: string; tags?: unknown; agents?: unknown; text?: string }) {
    return this.resources.update(id, body);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async remove(@Param('id') id: string) {
    await this.resources.remove(id);
    return { id, deleted: true };
  }
}
