import { BadRequestException, Body, Controller, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { MAX_VIDEO_UPLOAD_BYTES, TASK_QUOTA_BYTES, limitFor } from '../attachments/attachments.service';
import { VoiceService } from '../voice/voice.service';
import { MediaService } from './media.service';
import { VideoService } from './video.service';
import { VisionService } from './vision.service';

/** Settings → Vision, and what the media features can use on this server. */
@Controller()
export class MediaController {
  constructor(
    private readonly vision: VisionService,
    private readonly video: VideoService,
    private readonly voice: VoiceService,
    private readonly media: MediaService,
  ) {}

  @Get('media')
  async status() {
    return { vision: this.vision.get(), visionReady: this.vision.ready(), ffmpeg: await this.video.available(), sttReady: this.voice.sttReady(), limits: { videoUploadBytes: MAX_VIDEO_UPLOAD_BYTES, fileUploadBytes: limitFor('bin'), taskQuotaBytes: TASK_QUOTA_BYTES } };
  }

  /** Frames + transcript of a video that lives in the attachments or the resource library (processed once, then cached). */
  @Post('media/digest')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin', 'task_setter')
  async digest(@Body() body: { path?: string; everySeconds?: number; atSeconds?: number[]; phrases?: string[]; pointing?: boolean }) {
    try {
      return { text: await this.media.videoDigest(String(body?.path ?? ''), undefined, body) };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /** Ask the vision model about a photo / video (attachments or the resource library). */
  @Post('media/look')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin', 'task_setter')
  async look(@Body() body: { path?: string; question?: string; everySeconds?: number; atSeconds?: number[]; phrases?: string[]; pointing?: boolean }) {
    try {
      return { text: await this.media.lookAt(String(body?.path ?? ''), String(body?.question ?? ''), undefined, body) };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Put('vision')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async set(@Body() body: { provider?: unknown; model?: unknown }) {
    const cfg = await this.vision.save(body ?? {});
    return { ok: true, vision: cfg, visionReady: cfg !== null };
  }

  @Post('vision/test')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  test() {
    return this.vision.test();
  }
}
