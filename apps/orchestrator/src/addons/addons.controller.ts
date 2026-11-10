import { All, Controller, Get, HttpCode, NotFoundException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Roles } from '../identity/roles.decorator';
import { CurrentUser } from '../identity/current-user.decorator';
import type { UserRow } from '../users/users.service';
import { RolesGuard } from '../identity/roles.guard';
import { AddonsService } from './addons.service';
import { AddonsViewProxyService } from './addons-view-proxy.service';

/**
 * Installing and removing an add-on stays on the server (`aigentron addon enable|disable`): any signed-in person may see what is installed and the
 * command to run. An operator can STOP, START or RESTART an installed single-service add-on (Playwright, voice) — `control`. The browser VIEW (the page under `browser/view/`) is operator/admin only
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

  /** Stop / start / restart an installed add-on's service (Playwright, voice) — what the dashboard's buttons call. */
  @Post(':name/control/:action')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  control(@Param('name') name: string, @Param('action') action: string, @CurrentUser() user: UserRow | undefined) {
    return this.addons.control(name, action, user?.displayName);
  }

  @Get(':name')
  async get(@Param('name') name: string) {
    const info = await this.addons.info(name);
    if (!info) throw new NotFoundException(`No add-on "${name}"`);
    return info;
  }
}
