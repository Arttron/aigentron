import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { ProviderLoginService } from './provider-login.service';

/** Sign in / out of a subscription provider from the dashboard. The credential never leaves the server; these routes return only the link, the short code and the status. */
@Controller('providers/:name')
@UseGuards(RolesGuard)
@Roles('operator', 'admin')
export class ProviderLoginController {
  constructor(private readonly login: ProviderLoginService) {}

  @Get('login')
  status(@Param('name') name: string) {
    return this.login.status(name);
  }

  @Post('login/start')
  start(@Param('name') name: string) {
    return this.login.start(name);
  }

  @Post('login/code')
  code(@Param('name') name: string, @Body() body: { code?: unknown }) {
    return this.login.submit(name, typeof body?.code === 'string' ? body.code : '');
  }

  @Delete('login')
  cancel(@Param('name') name: string) {
    return this.login.cancel(name);
  }

  @Post('logout')
  logout(@Param('name') name: string) {
    return this.login.logout(name);
  }
}
