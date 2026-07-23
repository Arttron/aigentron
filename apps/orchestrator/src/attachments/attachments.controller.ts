import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { AttachmentsService } from './attachments.service';

/** Attachments for a task, any file type (raw-body upload — no multer dependency). */
@Controller('tasks/:id/attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /**
   * Upload one file as the raw request body. The client sends the bytes with
   * the file's content-type and an `x-filename` header (URL-encoded).
   */
  @Post()
  async upload(@Param('id') id: string, @Req() req: Request) {
    const rawName = decodeURIComponent(req.header('x-filename') ?? 'upload');
    return this.attachments.save(id, rawName, req);
  }

  @Get()
  list(@Param('id') id: string) {
    return this.attachments.list(id);
  }

  @Get(':file')
  async serve(@Param('id') id: string, @Param('file') file: string, @Res() res: Response) {
    const { path, mime, inline, name } = await this.attachments.filePath(id, file);
    res.setHeader('content-type', mime);
    res.setHeader('cache-control', 'private, max-age=300');
    // Anything outside the known-safe inline set (images/PDF) force-downloads
    // instead of rendering — an uploaded .html/.svg/.js must never execute as
    // same-origin script just because its URL was opened in a browser tab.
    if (!inline) res.setHeader('content-disposition', `attachment; filename="${name}"`);
    createReadStream(path).pipe(res);
  }
}
