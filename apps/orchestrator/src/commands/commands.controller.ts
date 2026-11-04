import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CommandPipelineService } from './command-pipeline.service';

/** `/api/commands-mcp` — the command pipeline's tools over HTTP MCP. A machine route (loopback only) that also needs the run's bearer token. */
@Controller('commands-mcp')
export class CommandsController {
  constructor(private readonly pipeline: CommandPipelineService) {}

  @All()
  handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.pipeline.handle(req, res);
  }
}
