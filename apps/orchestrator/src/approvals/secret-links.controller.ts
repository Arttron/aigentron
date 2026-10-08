import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { SecretLinksService } from './secret-links.service';

/**
 * Public on purpose (no session): the unguessable one-time token IS the credential, and it can only set the one value that a
 * pending request_secret approval asked for. See SecretLinksService.
 */
@Controller('secret-links')
export class SecretLinksController {
  constructor(private readonly links: SecretLinksService) {}

  @Get(':token')
  peek(@Param('token') token: string) {
    return this.links.peek(token);
  }

  @Post(':token')
  @HttpCode(200)
  async submit(@Param('token') token: string, @Body() body: { value?: string }) {
    await this.links.submit(token, String(body?.value ?? ''));
    return { ok: true };
  }
}
