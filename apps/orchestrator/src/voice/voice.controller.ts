import { BadRequestException, Body, Controller, Get, HttpCode, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { VoiceService } from './voice.service';
import { MAX_AUDIO_BYTES } from './voice-core';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';

/** Read a raw request body with a hard size cap. */
async function readBody(req: Request, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new BadRequestException(`The upload is too large (max ${Math.round(max / 1048576)} MB).`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

@Controller('voice')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  /** The current settings and what is usable — the UI shows the mic / speaker buttons only when it is. */
  @Get()
  get() {
    const c = this.voice.get();
    return { ...c, sttReady: c.stt !== null, ttsReady: c.tts !== null };
  }

  @Put()
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async set(@Body() body: unknown) {
    const c = await this.voice.save(body);
    return { ...c, sttReady: c.stt !== null, ttsReady: c.tts !== null };
  }

  @Post('test')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  test() {
    return this.voice.test();
  }

  /** A recording as the raw body (`content-type: audio/*`) → its text. */
  @Post('transcribe')
  @HttpCode(200)
  async transcribe(@Req() req: Request) {
    const data = await readBody(req, MAX_AUDIO_BYTES);
    return { text: await this.voice.transcribe(data, req.header('content-type') ?? undefined) };
  }

  /** Read an answer aloud: `{text}` → MP3. */
  @Post('speak')
  @HttpCode(200)
  async speak(@Body() body: { text?: string }, @Res() res: Response) {
    const r = await this.voice.speak(String(body?.text ?? ''), 'mp3');
    res.setHeader('content-type', r.mime);
    res.setHeader('x-speech-truncated', r.truncated ? '1' : '0');
    res.setHeader('cache-control', 'no-store');
    res.send(r.audio);
  }
}
