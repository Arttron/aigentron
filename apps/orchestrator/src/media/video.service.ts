import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { VoiceService, type TimedSegment } from '../voice/voice.service';
import { POINTING_PHRASES, MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, buildDigest, mergeMoments, momentsFromSpeech, parseProbe, planFrames, type FramePlan, type ProbeResult } from './media-core';

const pexec = promisify(execFile);
const DIGEST_VERSION = 2;

/** Same plan → same cache entry. */
const planKey = (p: FramePlan): string => JSON.stringify([p.everySeconds ?? null, [...(p.atSeconds ?? [])].sort((a, b) => a - b), [...(p.phrases ?? [])].map((x) => x.toLowerCase()).sort(), Boolean(p.pointing)]);

export interface Digest {
  text: string;
  dir: string;
  frames: { t: number; path: string; why?: string }[];
  durationSec: number;
}

/** The digest folder of a video: `<agentDir>/cache/digests/<sha256 of its path>` — one per file, wherever the file lives. */
export const digestDirFor = (agentDir: string, file: string): string => join(agentDir, 'cache', 'digests', createHash('sha256').update(file).digest('hex').slice(0, 32));

/** Where digests were kept before 0.1.63: next to the video. Read once as a fallback (then moved), never written again. */
export const legacyDigestDir = (file: string): string => `${file}.digest`;

interface Meta {
  id: string;
  plan: string;
  /** The video this cache belongs to (for the disk report and for humans looking at the cache folder). */
  file?: string;
  durationSec?: number;
}

/**
 * Video → what an agent can use: a handful of frames (JPEG) and, when speech recognition is set up, a transcript of the sound. Needs
 * ffmpeg (installed by the installer / in the Docker image). The result is cached under `<agentDir>/cache/digests/<hash>` (one folder
 * per video, wherever the video sits — never next to it, so a workspace or a git worktree is not littered), so a video is processed
 * once, and an unchanged file is never redone.
 */
@Injectable()
export class VideoService {
  private readonly logger = new Logger('Video');
  private ffmpegOk: boolean | null = null;
  private running = new Map<string, Promise<Digest>>();
  /** Builds of the same file never overlap (they share one folder, and a build clears it): the next plan waits for the previous. */
  private fileChain = new Map<string, Promise<unknown>>();

  constructor(
    private readonly voice: VoiceService,
    private readonly config: AppConfigService,
  ) {}

  /** The cache folder of a video. */
  digestDir(file: string): string {
    return digestDirFor(this.config.agentDir, file);
  }

  private async readMeta(dir: string): Promise<Meta | null> {
    try {
      const m = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Meta;
      return m && typeof m.id === 'string' && typeof m.plan === 'string' ? m : null;
    } catch {
      return null;
    }
  }

  /**
   * A digest built by an older version sits next to the video: move it into the cache folder (same disk → a rename; the frame paths
   * inside are rewritten) so nothing already processed is lost, and the old folder disappears from the user's files.
   */
  async adoptLegacy(file: string, dir = this.digestDir(file)): Promise<void> {
    const old = legacyDigestDir(file);
    if (!(await stat(old).then((s) => s.isDirectory(), () => false))) return;
    if (await this.readMeta(dir)) {
      await rm(old, { recursive: true, force: true }).catch(() => undefined); // the cache already has a newer one
      return;
    }
    try {
      await mkdir(join(dir, '..'), { recursive: true, mode: 0o700 });
      await rm(dir, { recursive: true, force: true });
      await rename(old, dir);
      for (const name of ['frames.json', 'digest.md']) {
        const text = await readFile(join(dir, name), 'utf8').catch(() => null);
        if (text !== null) await writeFile(join(dir, name), text.split(old).join(dir));
      }
      this.logger.log(`moved the digest of ${basename(file)} into the cache folder`);
    } catch (e) {
      // another disk, or a half-written folder: rebuilding is cheaper than guessing
      this.logger.warn(`could not move the old digest of ${basename(file)} (${(e as Error).message}); it is rebuilt`);
      await rm(old, { recursive: true, force: true }).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async available(): Promise<boolean> {
    if (this.ffmpegOk === null) {
      this.ffmpegOk = await pexec('ffmpeg', ['-version'], { timeout: 10_000 }).then(() => true, () => false);
    }
    return this.ffmpegOk;
  }

  async probe(file: string): Promise<ProbeResult | null> {
    try {
      const { stdout } = await pexec('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      const json = JSON.parse(stdout) as { format?: Record<string, unknown> };
      const parsed = parseProbe(json);
      if (parsed) return parsed;
      // No duration anywhere (a clip recorded in the browser): the last packet's timestamp is the length.
      const last = await this.lastPacketTime(file);
      return last ? parseProbe({ ...json, format: { ...(json.format ?? {}), duration: last } }) : null;
    } catch {
      return null;
    }
  }

  /** Largest packet timestamp (s) of the first video stream; null when unreadable. Reads packet headers only. */
  private async lastPacketTime(file: string): Promise<number | null> {
    try {
      const { stdout } = await pexec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', file], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
      let end = 0;
      for (const line of stdout.split('\n')) {
        const [pts, dur] = line.split(',').map(Number);
        if (Number.isFinite(pts)) end = Math.max(end, pts! + (Number.isFinite(dur) ? dur! : 0));
      }
      return end > 0 ? end : null;
    } catch {
      return null;
    }
  }

  private run(cmd: string, args: string[], timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-600)));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cmd} took too long`));
      }, timeoutMs);
      child.on('error', (e) => (clearTimeout(timer), reject(e)));
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${cmd} failed: ${err.trim().split('\n').pop() ?? code}`));
      });
    });
  }

  /** Frames + transcript of a video (cached). Concurrent calls for the same file and plan share one run. */
  digest(file: string, opts: { force?: boolean } & FramePlan = {}): Promise<Digest> {
    const key = `${file}|${planKey(opts)}`;
    const existing = this.running.get(key);
    if (existing) return existing;
    const prev = this.fileChain.get(file) ?? Promise.resolve();
    const p = prev.then(() => this.build(file, opts)).finally(() => {
      this.running.delete(key);
      if (this.fileChain.get(file) === settled) this.fileChain.delete(file);
    });
    const settled = p.catch(() => undefined);
    this.fileChain.set(file, settled);
    this.running.set(key, p);
    return p;
  }

  /** The soundtrack as timed phrases — cached beside the frames, so changing the frame plan never pays for recognition twice. */
  private async transcript(file: string, dir: string, id: string, probe: ProbeResult): Promise<{ text: string | null; segments: TimedSegment[]; note?: string }> {
    if (!probe.hasAudio) return { text: null, segments: [], note: 'the video has no sound.' };
    if (!this.voice.sttReady()) return { text: null, segments: [], note: 'speech recognition is not set up (Settings → Voice), so the sound was not transcribed.' };
    const cache = join(dir, 'transcript.json');
    try {
      const c = JSON.parse(await readFile(cache, 'utf8')) as { id: string; text: string | null; segments: TimedSegment[]; note?: string };
      if (c.id === id) return c;
    } catch {
      /* not cached yet */
    }
    const audio = join(dir, 'audio.mp3');
    let out: { text: string | null; segments: TimedSegment[]; note?: string };
    try {
      await this.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', '-t', String(MAX_VIDEO_SECONDS), '-y', audio], 300_000);
      const r = await this.voice.transcribeTimed(await readFile(audio), 'audio/mpeg');
      out = r.text ? { text: r.text, segments: r.segments } : { text: null, segments: [], note: 'no speech was recognised.' };
    } catch (e) {
      return { text: null, segments: [], note: `the sound could not be transcribed (${(e as Error).message.slice(0, 120)}).` };
    } finally {
      await rm(audio, { force: true });
    }
    await writeFile(cache, JSON.stringify({ id, ...out }));
    return out;
  }

  private async build(file: string, opts: { force?: boolean } & FramePlan): Promise<Digest> {
    if (!(await this.available())) throw new Error('Video processing is not available: ffmpeg is not installed on this server (the installer adds it; or install ffmpeg).');
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) throw new Error('That video file was not found.');
    if (st.size > MAX_VIDEO_BYTES) throw new Error(`The video is too large (${Math.round(st.size / 1048576)} MB; the limit is ${MAX_VIDEO_BYTES / 1048576} MB).`);
    const dir = this.digestDir(file);
    await this.adoptLegacy(file, dir);
    const id = JSON.stringify({ v: DIGEST_VERSION, size: st.size, mtime: Math.round(st.mtimeMs), stt: this.voice.sttReady() });
    const plan = planKey(opts);
    const cached = await this.readMeta(dir);
    if (!opts.force && cached && cached.id === id && cached.plan === plan) {
      try {
        const d = await this.load(dir, cached);
        await utimes(dir, new Date(), new Date()).catch(() => undefined); // a digest in use stays young for the cache pruning
        return d;
      } catch {
        /* incomplete: rebuilt below */
      }
    }
    const probe = await this.probe(file);
    if (!probe) throw new Error('That does not look like a video I can read.');
    if (probe.durationSec > MAX_VIDEO_SECONDS) throw new Error(`The video is too long (${Math.round(probe.durationSec / 60)} min; the limit is ${MAX_VIDEO_SECONDS / 60} min). Trim it and try again.`);

    await mkdir(dir, { recursive: true, mode: 0o700 });
    // A different video → start clean; the same video with another frame plan keeps its transcript.
    if (cached?.id !== id || opts.force) await rm(join(dir, 'transcript.json'), { force: true });
    for (const f of await readdir(dir)) if (f !== 'transcript.json') await rm(join(dir, f), { recursive: true, force: true });

    const tr = await this.transcript(file, dir, id, probe);

    // Which moments? A fixed step, exact times, the moments some words are said — or, if none of those was asked, the automatic spread.
    const wanted = Boolean(opts.everySeconds || opts.atSeconds?.length || opts.phrases?.length || opts.pointing);
    const spoken = opts.pointing || opts.phrases?.length ? momentsFromSpeech(tr.segments, [...(opts.pointing ? POINTING_PHRASES : []), ...(opts.phrases ?? [])]) : [];
    let frameNote: string | undefined;
    if ((opts.pointing || opts.phrases?.length) && !spoken.length)
      frameNote = tr.segments.length
        ? 'none of those phrases was said in the video.'
        : tr.text
          ? 'the speech model gives no timestamps, so frames cannot be tied to words (use a Whisper model in Settings → Voice, e.g. whisper-1).'
          : `frames could not be tied to words — ${tr.note ?? 'no speech'}`;
    const stepOnly = opts.everySeconds || !wanted || (!spoken.length && !opts.atSeconds?.length);
    const moments = mergeMoments(
      [
        ...(opts.atSeconds ?? []).map((t) => ({ t, why: undefined as string | undefined })),
        ...spoken,
        ...(stepOnly ? planFrames(probe.durationSec, opts.everySeconds).map((t) => ({ t })) : []),
      ],
      probe.durationSec,
    );
    const frames: { t: number; path: string; why?: string }[] = [];
    let i = 0;
    for (const { t, why } of moments) {
      const out = join(dir, `frame-${String(++i).padStart(2, '0')}.jpg`);
      await this.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', "scale='min(1024,iw)':-2", '-q:v', '4', '-y', out], 60_000).catch((e) => this.logger.warn(`frame at ${t}s failed: ${(e as Error).message}`));
      if (existsSync(out)) frames.push({ t, path: out, ...(why ? { why } : {}) });
    }
    if (!frames.length) throw new Error('Could not take any frame from that video.');

    const text = buildDigest({
      name: basename(file),
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      frames,
      transcript: tr.text,
      transcriptNote: tr.note,
      segments: tr.segments,
      frameNote,
      everySeconds: opts.everySeconds,
      custom: !stepOnly || Boolean(opts.atSeconds?.length),
    });
    await writeFile(join(dir, 'digest.md'), text);
    await writeFile(join(dir, 'frames.json'), JSON.stringify(frames));
    const meta: Meta = { id, plan, file, durationSec: probe.durationSec };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta)); // written last: an interrupted run is never mistaken for a finished one
    return { text, dir, frames, durationSec: probe.durationSec };
  }

  private async load(dir: string, meta: Meta): Promise<Digest> {
    const frames = JSON.parse(await readFile(join(dir, 'frames.json'), 'utf8')) as { t: number; path: string; why?: string }[];
    const names = new Set(await readdir(dir));
    if (!frames.every((f) => names.has(basename(f.path)))) throw new Error('cache incomplete');
    return { text: await readFile(join(dir, 'digest.md'), 'utf8'), dir, frames, durationSec: meta.durationSec ?? 0 };
  }
}
