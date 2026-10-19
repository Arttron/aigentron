import { All, Controller, Get, NotFoundException, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { AddonsService } from './addons.service';
import { AddonsViewProxyService } from './addons-view-proxy.service';

/**
 * Add-ons are read-only from here: any signed-in person may see what is installed and the command to run on the server;
 * nothing is enabled or disabled through the API. The browser VIEW (the page under `browser/view/`) is operator/admin only
 * — whoever watches can type into the shared browser. Its WebSocket is handled on the server's `upgrade` event with the
 * same checks (view-proxy.ts), since Express never sees upgrades.
 */
@Controller('addons')
export class AddonsController {
  constructor(
    private readonly addons: AddonsService,
    private readonly view: AddonsViewProxyService,
  ) {}

  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  @All(['browser/view', 'browser/view/*path'])
  browserView(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.view.proxy.handleHttp(req, res);
  }

  @Get()
  list() {
    return this.addons.list();
  }

  @Get(':name')
  async get(@Param('name') name: string) {
    const info = await this.addons.info(name);
    if (!info) throw new NotFoundException(`No add-on "${name}"`);
    return info;
  }
}
