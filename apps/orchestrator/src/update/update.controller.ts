import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { UpdateService } from './update.service';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';

/** Settings → Updates (and `aigentron`). Applying needs an operator/admin; the admin assistant has its own approval-gated tool. */
@Controller('update')
export class UpdateController {
  constructor(private readonly update: UpdateService) {}

  @Get()
  status() {
    return this.update.status();
  }

  @Post('check')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  check() {
    return this.update.status(true);
  }

  @Post('apply')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  apply(@Body() body: { version?: string; force?: boolean }, @Req() req: { authUserId?: string }) {
    return this.update.apply({ version: body?.version, force: body?.force === true, by: req.authUserId ?? 'dashboard' });
  }
}
