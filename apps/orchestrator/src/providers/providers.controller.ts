import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ProvidersService, type ProviderPatch } from './providers.service';
import { CreateProviderDto, ModelsPreviewDto, UpdateProviderDto } from './dto/provider.dto';

type ProviderRow = Awaited<ReturnType<ProvidersService['getRow']>>;

/** Wire shape — the secret is write-only and masked. */
function serialize(p: ProviderRow) {
  return {
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.model,
    authMode: p.authMode,
    secretSet: Boolean(p.secret),
    secretHint: p.secret ? `…${p.secret.slice(-4)}` : null,
    rpm: p.rpm,
    tpm: p.tpm,
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** '' clears the secret; undefined leaves it. */
function toPatch(dto: UpdateProviderDto): ProviderPatch {
  const patch: ProviderPatch = {};
  if (dto.kind !== undefined) patch.kind = dto.kind;
  if (dto.baseUrl !== undefined) patch.baseUrl = dto.baseUrl || null;
  if (dto.model !== undefined) patch.model = dto.model;
  if (dto.authMode !== undefined) patch.authMode = dto.authMode;
  if (dto.secret !== undefined) patch.secret = dto.secret || null;
  // 0/empty clears the cap; a positive number sets it.
  if (dto.rpm !== undefined) patch.rpm = dto.rpm || null;
  if (dto.tpm !== undefined) patch.tpm = dto.tpm || null;
  return patch;
}

@Controller('providers')
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  async list() {
    return (await this.providers.list()).map(serialize);
  }

  @Post()
  async create(@Body() dto: CreateProviderDto) {
    return serialize(
      await this.providers.create({
        name: dto.name,
        kind: dto.kind,
        baseUrl: dto.baseUrl || null,
        model: dto.model ?? '',
        authMode: dto.authMode,
        secret: dto.secret || null,
        rpm: dto.rpm ?? null,
        tpm: dto.tpm ?? null,
      }),
    );
  }

  @Put(':name')
  async update(@Param('name') name: string, @Body() dto: UpdateProviderDto) {
    return serialize(await this.providers.update(name, toPatch(dto)));
  }

  /** Preview a provider's model list from ad-hoc params (create/edit form). */
  @Post('models-preview')
  modelsPreview(@Body() dto: ModelsPreviewDto) {
    return this.providers.previewModels(dto);
  }

  /** Connectivity check: send a tiny "whoami" request to the provider. */
  @Post(':name/test')
  test(@Param('name') name: string) {
    return this.providers.test(name);
  }

  /** Models the provider advertises (for the agent model picker). */
  @Get(':name/models')
  models(@Param('name') name: string) {
    return this.providers.listModels(name);
  }

  @Delete(':name')
  async remove(@Param('name') name: string) {
    await this.providers.remove(name);
    return { name, deleted: true };
  }
}
