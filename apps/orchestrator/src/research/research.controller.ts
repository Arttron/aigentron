import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ResearchMcpService } from './research-mcp.service';

/** `/api/research-mcp` — read-only research tools (search / fetch / verify_quote) over HTTP MCP. */
@Controller('research-mcp')
export class ResearchController {
  constructor(private readonly mcp: ResearchMcpService) {}

  @All()
  handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.mcp.handle(req, res);
  }
}
