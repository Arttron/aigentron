import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InternalMcpService } from './internal-mcp.service';

/** `/api/internal-mcp` — per-run HTTP MCP for agent runtimes without in-process tools. Bearer-token only. */
@Controller('internal-mcp')
export class InternalMcpController {
  constructor(private readonly service: InternalMcpService) {}

  @All()
  handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.service.handle(req, res);
  }
}
