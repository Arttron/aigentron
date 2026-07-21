import { Controller, Get } from '@nestjs/common';
import { LitellmService } from './litellm.service';

@Controller('litellm')
export class LitellmController {
  constructor(private readonly litellm: LitellmService) {}

  /** The proxy's configured routes (read-only; keys never exposed). */
  @Get('routes')
  routes() {
    return this.litellm.listRoutes();
  }
}
