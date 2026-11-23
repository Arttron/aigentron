import { Body, Controller, Get, Headers, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LocalLlmService } from './local-llm.service';

/** `/api/local-llm/v1` — OpenAI-compatible. A machine route (loopback only) that also needs the install's own bearer. */
@Controller('local-llm/v1')
export class LocalLlmController {
  constructor(private readonly llm: LocalLlmService) {}

  @Get('models')
  models(@Headers('authorization') auth: string | undefined) {
    if (!this.llm.authorized(auth)) throw new UnauthorizedException();
    return this.llm.modelsResponse();
  }

  @Post('chat/completions')
  chat(@Headers('authorization') auth: string | undefined, @Req() req: Request, @Res() res: Response, @Body() _body: unknown): Promise<void> {
    if (!this.llm.authorized(auth)) throw new UnauthorizedException();
    return this.llm.chat(req, res);
  }
}
