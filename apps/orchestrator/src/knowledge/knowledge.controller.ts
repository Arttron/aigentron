import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import type { ChunkingConfig } from './kb-core';
import { KnowledgeService } from './knowledge.service';

const MAX_UPLOAD = 20 * 1024 * 1024;

async function readBody(req: Request): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    n += b.length;
    if (n > MAX_UPLOAD) throw new BadRequestException(`The file is too large (limit ${MAX_UPLOAD / 1048576} MB).`);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/** Knowledge bases: manage them, add documents, try a search. (Agents use them through the kb_* tools.) */
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly kb: KnowledgeService) {}

  @Get()
  list() {
    return this.kb.list();
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

  @Post(':name/docs/note')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  note(@Param('name') name: string, @Body() body: { title?: string; text?: string }) {
    return this.kb.addDocument(name, { title: body?.title, text: String(body?.text ?? ''), source: 'note', kind: 'note' });
  }

  /** One file as the raw body (`x-filename`, URL-encoded; optional `x-title`). */
  @Post(':name/docs/upload')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async upload(@Param('name') name: string, @Req() req: Request) {
    const dec = (h: string) => {
      const v = req.header(h);
      return v ? decodeURIComponent(v) : undefined;
    };
    return this.kb.addFile(name, dec('x-filename') ?? 'upload.txt', await readBody(req), dec('x-title'));
  }

  @Post(':name/import/resource')
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

  @Delete('docs/:docId')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async removeDoc(@Param('docId') docId: string) {
    await this.kb.removeDoc(docId);
    return { id: docId, deleted: true };
  }

  /** Try a search the way an agent would. */
  @Post(':name/search')
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
