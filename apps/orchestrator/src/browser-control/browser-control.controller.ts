import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BrowserMcpService } from './browser-mcp.service';

/** `/api/browser-mcp` — the browser-control tools over HTTP MCP. A machine route (loopback only) that also needs the run's bearer token. */
@Controller('browser-mcp')
export class BrowserControlController {
  constructor(private readonly mcp: BrowserMcpService) {}

  @All()
  handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.mcp.handle(req, res);
  }
}
