import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ProxyGatewayService } from './proxy-gateway.service';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';

/** Saved proxy connections for the browser (Add-ons → Playwright). Writes are for operators; no answer ever carries a password. */
@Controller('proxies')
export class ProxiesController {
  constructor(private readonly proxies: ProxyGatewayService) {}

  @Get()
  list() {
    return this.proxies.list();
  }

  /** Save a proxy: `line` is the seller's text in any usual shape (host;port;user;pass …). */
  @Post()
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  add(@Body() body: { name?: string; line?: string }) {
    try {
      return this.proxies.store.add(String(body?.name ?? ''), String(body?.line ?? ''));
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  remove(@Param('id') id: string) {
    if (!this.proxies.store.remove(id)) throw new NotFoundException('no such proxy');
    return { id, deleted: true };
  }

  /** Which connection the browser goes through: `{ id }`, or `{ id: null }` for direct. */
  @Put('active')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  setActive(@Body() body: { id?: string | null }) {
    const id = typeof body?.id === 'string' && body.id ? body.id : null;
    if (!this.proxies.choose(id)) throw new NotFoundException('no such proxy');
    return this.proxies.list();
  }

  /** May agents choose among the saved proxies (the `browser_proxy_use` tool)? */
  @Put('agents')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  setAgents(@Body() body: { allowed?: boolean }) {
    this.proxies.store.setAgentsCanSwitch(body?.allowed !== false);
    return this.proxies.list();
  }

  @Post(':id/test')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  test(@Param('id') id: string) {
    return this.proxies.test(id);
  }
}
