import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LocalOsMcpService } from './local-os-mcp.service';

/** `/api/local-os-mcp` — the repository tools over HTTP MCP. A machine route (loopback only) that also needs the run's bearer token. */
@Controller('local-os-mcp')
export class LocalOsMcpController {
  constructor(private readonly mcp: LocalOsMcpService) {}

  @All()
  handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.mcp.handle(req, res);
  }
}
