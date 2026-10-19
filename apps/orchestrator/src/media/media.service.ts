import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { imageMime, isImage, isVideo } from '../files/file-types';
import { insideRoot, isSecretPath, realInside } from '../files/fs-safe';
import { MAX_IMAGES_PER_LOOK, formatTime, MIN_EVERY_SECONDS, type FramePlan } from './media-core';
import { VideoService } from './video.service';
import { VisionService, type LookImage } from './vision.service';

/** What a tool/HTTP caller asked for → a frame plan: a step (seconds), exact times, phrases to catch in the speech. Junk is dropped. */
export function cleanPlan(v: { everySeconds?: unknown; atSeconds?: unknown; phrases?: unknown; pointing?: unknown } | undefined): FramePlan {
  const n = Number(v?.everySeconds);
  const times = Array.isArray(v?.atSeconds) ? v.atSeconds.map(Number).filter((x) => Number.isFinite(x) && x >= 0).slice(0, 60) : [];
  const phrases = Array.isArray(v?.phrases) ? v.phrases.map((p) => String(p).trim()).filter(Boolean).slice(0, 20) : [];
  return {
    ...(Number.isFinite(n) && n >= MIN_EVERY_SECONDS ? { everySeconds: Math.min(Math.round(n * 10) / 10, 600) } : {}),
    ...(times.length ? { atSeconds: times } : {}),
    ...(phrases.length ? { phrases } : {}),
    ...(v?.pointing === true ? { pointing: true } : {}),
  };
}

/** The agents' media tools: `look_at` (a photo or video frames → the vision model) and `video_digest` (frames + transcript). */
@Injectable()
export class MediaService {
  constructor(
    private readonly config: AppConfigService,
    private readonly video: VideoService,
    private readonly vision: VisionService,
  ) {}

  /**
   * A path an agent gave us, checked: it must really be inside this task's attachments, the resource library or the
   * extra roots the caller allows (its worktree, the folder of ITS project). With a task id the caller names the
   * project folder itself — the shared workspace is never implied, so a task of one project cannot read another's;
   * without a task id (the HTTP endpoints) the shared workspace is allowed, as before.
   */
  async safePath(path: string, worktree?: string | string[], taskId?: string): Promise<string> {
    const extra = Array.isArray(worktree) ? worktree : worktree ? [worktree] : [];
    // With a task id only THAT task's attachments are readable (not other tasks' files); without one (the HTTP endpoints) the whole folder, as before.
    if (taskId !== undefined && !/^[\w-]+$/.test(taskId)) throw new Error('That path is not available.');
    const roots = [taskId !== undefined ? join(this.config.attachmentsDir, taskId) : this.config.attachmentsDir, join(this.config.agentDir, 'resources'), ...(taskId === undefined ? [this.config.workspaceDir] : []), ...extra].filter(Boolean);
    if (!path.startsWith('/') || !insideRoot(path, roots)) throw new Error('That path is not available: give the full path of a photo or video from the task\'s attachments, the resource library, or the workspace.');
    const real = await realInside(path, roots); // symlinks followed on both sides: a link out of the roots is refused
    if (!real || isSecretPath(real) || isSecretPath(path)) throw new Error('That file was not found.');
    return real;
  }

  async videoDigest(path: string, worktree?: string | string[], plan?: Parameters<typeof cleanPlan>[0], taskId?: string): Promise<string> {
    const file = await this.safePath(path, worktree, taskId);
    if (!isVideo(file)) throw new Error('video_digest is for video files (mp4, mov, webm …).');
    return (await this.video.digest(file, cleanPlan(plan))).text;
  }

  async lookAt(path: string, question: string, worktree?: string | string[], plan?: Parameters<typeof cleanPlan>[0], own?: { provider: string; model: string }, taskId?: string): Promise<string> {
    const file = await this.safePath(path, worktree, taskId);
    const images: LookImage[] = [];
    let intro = '';
    if (isVideo(file)) {
      const d = await this.video.digest(file, cleanPlan(plan));
      const pick = d.frames.length <= MAX_IMAGES_PER_LOOK ? d.frames : Array.from({ length: MAX_IMAGES_PER_LOOK }, (_, i) => d.frames[Math.round((i * (d.frames.length - 1)) / (MAX_IMAGES_PER_LOOK - 1))]!);
      for (const f of pick) images.push({ data: await readFile(f.path), mime: 'image/jpeg' });
      intro = `These are ${pick.length} frames taken in order from a video${d.durationSec ? ` of ${Math.round(d.durationSec)} s` : ''}. `;
      const said = pick.map((f, i) => (f.why ? `frame ${i + 1} (${formatTime(f.t)}) was taken when the speaker said ${f.why}` : '')).filter(Boolean);
      if (said.length) intro += `${said.join('; ')}. `;
    } else if (isImage(file)) {
      images.push({ data: await readFile(file), mime: imageMime(file) });
    } else {
      throw new Error('look_at takes a photo (jpg, png, webp, gif) or a video.');
    }
    return this.vision.describe(images, `${intro}${question}`, own);
  }
}
