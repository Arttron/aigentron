import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { tokenFromRequest } from '../auth/auth-core';
import { ProjectsService } from '../projects/projects.service';
import { LocalDevicesService } from './local-devices.service';
import { cloneableProjects } from './local-projects';

/** `GET /api/local-agent/projects` — what `aigentron open` asks. The computer's own token is the credential (like the download routes, no session). */
@Controller('local-agent/projects')
export class LocalProjectsController {
  constructor(
    private readonly devices: LocalDevicesService,
    private readonly projects: ProjectsService,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    const device = this.devices.verify(tokenFromRequest(req.headers));
    if (!device) throw new UnauthorizedException('This computer is not paired (or was disconnected).');
    this.devices.touch?.(device.id);
    return { projects: cloneableProjects(await this.projects.list()) };
  }
}
