import { BadRequestException, Body, HttpException, HttpStatus, Controller, Get, HttpCode, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { VoiceService } from './voice.service';
import { CallGate, MAX_AUDIO_BYTES } from './voice-core';
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

type AuthedRequest = Request & { authUserId?: string };

@Controller('voice')
export class VoiceController {
  /** Paid calls: a few at once and a modest rate per person (see CallGate). */
  private readonly gate = new CallGate(30, 60_000, 3);

  constructor(private readonly voice: VoiceService) {}

  private enter(req: AuthedRequest): () => void {
    const release = this.gate.enter(req.authUserId ?? req.ip ?? 'anonymous');
    if (!release) throw new HttpException('Too many voice requests — wait a moment.', HttpStatus.TOO_MANY_REQUESTS);
    return release;
  }

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
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin', 'task_setter')
  async transcribe(@Req() req: AuthedRequest) {
    const release = this.enter(req);
    try {
      const data = await readBody(req, MAX_AUDIO_BYTES);
      return { text: await this.voice.transcribe(data, req.header('content-type') ?? undefined) };
    } finally {
      release();
    }
  }

  /** Read an answer aloud: `{text}` → MP3. */
  @Post('speak')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin', 'task_setter')
  async speak(@Req() req: AuthedRequest, @Body() body: { text?: string }, @Res() res: Response) {
    const release = this.enter(req);
    let r: Awaited<ReturnType<VoiceService['speak']>>;
    try {
      r = await this.voice.speak(String(body?.text ?? ''), 'mp3');
    } finally {
      release();
    }
    res.setHeader('content-type', r.mime);
    res.setHeader('x-speech-truncated', r.truncated ? '1' : '0');
    res.setHeader('cache-control', 'no-store');
    res.send(r.audio);
  }
}
