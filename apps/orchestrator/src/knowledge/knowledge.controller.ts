import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { readBodyLimited } from '../files/file-io';
import type { ChunkingConfig } from './kb-core';
import { KnowledgeService } from './knowledge.service';

const MAX_UPLOAD = 20 * 1024 * 1024;

const readBody = (req: Request): Promise<Buffer> => readBodyLimited(req, MAX_UPLOAD, (limit) => new BadRequestException(`The file is too large (limit ${limit / 1048576} MB).`));

/**
 * Knowledge bases: manage them, add documents, try a search. (Agents use them through the kb_* tools.) A base is global
 * (`project: null`) or belongs to one project (`project: <slug>`): `POST` takes `project`, `PATCH` moves with `project: <slug> | null`.
 */
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly kb: KnowledgeService) {}

  /** `?project=all|global|<slug>` (default all); every base carries `project: <slug> | null`. */
  @Get()
  list(@Query('project') project?: string) {
    return this.kb.list(project?.trim() || 'all');
  }

  /** Dry run of the chunking settings on a sample text. */
  @Post('preview')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  preview(@Body() body: { text?: string; chunking?: Partial<ChunkingConfig> }) {
    return this.kb.preview(String(body?.text ?? ''), body?.chunking);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  create(@Body() body: Record<string, unknown>) {
    return this.kb.create(body as never);
  }

  @Get(':name')
  get(@Param('name') name: string) {
    return this.kb.get(name);
  }

  @Patch(':name')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  update(@Param('name') name: string, @Body() body: Record<string, unknown>) {
    return this.kb.update(name, body as never);
  }

  @Delete(':name')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async remove(@Param('name') name: string) {
    await this.kb.remove(name);
    return { name, deleted: true };
  }

  @Get(':name/docs')
  docs(@Param('name') name: string) {
    return this.kb.listDocs(name);
  }

  /** Answers 202 `{id, status: 'processing'}` at once; the note is cut and stored in the background (see `GET …/docs` for its state). */
  @Post(':name/docs/note')
  @HttpCode(202)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  note(@Param('name') name: string, @Body() body: { title?: string; text?: string }) {
    return this.kb.addNote(name, { title: body?.title, text: String(body?.text ?? '') });
  }

  /**
   * One file as the raw body (`x-filename`, URL-encoded; optional `x-title`). The body is read, then the request ends with 202
   * `{id, status: 'processing'}`: reading the PDF / Word file, cutting and storing happen in the background — a big file no longer
   * holds the request longer than a web proxy waits. `GET …/docs` shows `processing` → `ready` (or `error` with the reason).
   */
  @Post(':name/docs/upload')
  @HttpCode(202)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async upload(@Param('name') name: string, @Req() req: Request) {
    const dec = (h: string) => {
      const v = req.header(h);
      try {
        return v ? decodeURIComponent(v) : undefined;
      } catch {
        throw new BadRequestException(`The ${h} header is not valid URL-encoded text.`);
      }
    };
    return this.kb.addFile(name, dec('x-filename') ?? 'upload.txt', await readBody(req), dec('x-title'));
  }

  /** 202 as well: the resource is read and indexed in the background. */
  @Post(':name/import/resource')
  @HttpCode(202)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  importResource(@Param('name') name: string, @Body() body: { id?: string }) {
    return this.kb.importResource(name, String(body?.id ?? ''));
  }

  @Post(':name/import/research')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  importResearch(@Param('name') name: string) {
    return this.kb.importResearch(name);
  }

  /** Removes a stored document, or dismisses a failed background import. */
  @Delete('docs/:docId')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async removeDoc(@Param('docId') docId: string) {
    await this.kb.removeDoc(docId);
    return { id: docId, deleted: true };
  }

  /** Try a search the way an agent would. */
  @Post(':name/search')
  @UseGuards(RolesGuard)
  @Roles('reviewer', 'task_setter', 'operator', 'admin')
  search(@Param('name') name: string, @Body() body: { query?: string; limit?: number }) {
    return this.kb.search(String(body?.query ?? ''), { kb: name, limit: body?.limit });
  }

  /** (Re)make the vectors of chunks that have none — after a failed run or a change of embedding model. */
  @Post(':name/reembed')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async reembed(@Param('name') name: string) {
    const kb = await this.kb.get(name);
    void this.kb.embedMissing(kb.id).catch(() => undefined);
    return { started: Boolean(kb.embedProvider) };
  }
}
