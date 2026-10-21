import { Body, Controller, Delete, Get, Put, UseGuards } from '@nestjs/common';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { RunLimitsService } from './run-limits.service';

/** Settings → General → Run limits. */
@Controller('run-limits')
export class RunLimitsController {
  constructor(private readonly limits: RunLimitsService) {}

  @Get()
  get() {
    return { limits: this.limits.get(), defaults: this.limits.defaults() };
  }

  @Put()
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  save(@Body() body: Record<string, unknown>) {
    return { limits: this.limits.save(body ?? {}), defaults: this.limits.defaults() };
  }

  /** Back to the environment's values. */
  @Delete()
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  reset() {
    return { limits: this.limits.reset(), defaults: this.limits.defaults() };
  }
}
