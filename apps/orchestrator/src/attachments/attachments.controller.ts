import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';
import { pipeFile } from '../media/pipe-file';
import { serveWithRanges } from '../media/serve-range';
import { AttachmentsService } from './attachments.service';

/** Attachments for a task, any file type (raw-body upload — no multer dependency). */
@Controller('tasks/:id/attachments')
export class AttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Upload one file as the raw request body. The client sends the bytes with
   * the file's content-type and an `x-filename` header (URL-encoded).
   */
  @UseGuards(RolesGuard)
  @Roles('task_setter', 'operator', 'admin')
  @Post()
  async upload(@Param('id') id: string, @Req() req: Request) {
    // an upload for a task that does not exist would leave a folder nobody ever cleans up
    if (!/^[\w-]+$/.test(id) || !(await this.prisma.task.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Task not found.');
    let rawName: string;
    try {
      rawName = decodeURIComponent(req.header('x-filename') ?? 'upload');
    } catch {
      throw new BadRequestException('The file name is not valid (it must be URL-encoded).');
    }
    const declared = Number(req.header('content-length'));
    return this.attachments.save(id, rawName, req, Number.isFinite(declared) && declared > 0 ? declared : undefined);
  }

  @Get()
  list(@Param('id') id: string) {
    return this.attachments.list(id);
  }

  @Get(':file')
  async serve(@Param('id') id: string, @Param('file') file: string, @Req() req: Request, @Res() res: Response) {
    const { path, mime, inline, name } = await this.attachments.filePath(id, file);
    res.setHeader('content-type', mime);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'private, max-age=300');
    // Anything outside the known-safe inline set (images/PDF) force-downloads
    // instead of rendering — an uploaded .html/.svg/.js must never execute as
    // same-origin script just because its URL was opened in a browser tab.
    if (!inline) res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`); // names may be non-ASCII (кухня.docx): a raw value makes Node throw
    // Video needs byte ranges (browsers seek, and iOS refuses to play without them).
    if (mime.startsWith('video/')) return serveWithRanges(req, res, path);
    pipeFile(res, path);
  }
}
