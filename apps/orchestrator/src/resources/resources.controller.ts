import { Body, Controller, Delete, Get, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { ResourcesService } from './resources.service';
import { isInline } from './resources-core';
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
      return v ? decodeURIComponent(v) : undefined;
    };
    return this.resources.upload(dec('x-filename') ?? 'upload', req, { title: dec('x-title'), description: dec('x-description'), tags: dec('x-tags') });
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const r = await this.resources.get(id);
    return { ...r, text: r.kind === 'text' ? await this.resources.text(id) : undefined };
  }

  @Get(':id/file')
  async file(@Param('id') id: string, @Res() res: Response) {
    const r = await this.resources.get(id);
    res.setHeader('content-type', r.mime);
    res.setHeader('cache-control', 'private, max-age=60');
    res.setHeader('x-content-type-options', 'nosniff');
    // Only images and PDFs render in the browser; everything else downloads (an uploaded .html must never run as script).
    if (!isInline(r.kind)) res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(r.originalName)}"`);
    createReadStream(this.resources.pathOf(r)).pipe(res);
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
