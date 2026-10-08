/**
 * Aigentron mascot state controller for lottie-web.
 *
 * One Lottie file, every state is a segment of the same timeline
 * (aigentron_admin_states.json). Three kinds of transition:
 *
 *  - "phase"     loop -> loop. Both segments share the same 90-frame body motion,
 *                so the segment is swapped at the current frame. Instant, no jump.
 *  - "boundary"  loop -> one-shot. Queued, starts when the current loop ends
 *                (the pose there equals frame 0 of every state). Waits up to one loop.
 *  - "crossfade" loop -> one-shot, urgent. A second player starts the one-shot from
 *                frame 0 and fades in over the first one. Instant, tiny blend.
 *
 * A one-shot is never interrupted: requests made while it plays are applied when it ends.
 *
 * Usage:
 *   import lottie from 'lottie-web';
 *   import data from './aigentron_admin_states.json';
 *   const mascot = new Mascot(el, data, lottie);
 *   mascot.go('thinking');
 *   mascot.go('success', { urgent: true });
 */
import type { AnimationItem, LottiePlayer } from 'lottie-web';

export type StateName = 'idle' | 'thinking' | 'success' | 'error';
export type TransitionKind = 'phase' | 'boundary' | 'crossfade' | 'end';

export interface StateDef {
  /** [first frame, end frame) on the shared timeline */
  seg: [number, number];
  loop: boolean;
  /** where a one-shot returns to */
  next?: StateName;
}

export const STATES: Record<StateName, StateDef> = {
  idle: { seg: [0, 90], loop: true },
  thinking: { seg: [90, 180], loop: true },
  success: { seg: [180, 240], loop: false, next: 'idle' },
  error: { seg: [240, 300], loop: false, next: 'idle' },
};

export interface MascotOptions {
  /** crossfade length in ms */
  fadeMs?: number;
  autoplay?: boolean;
  /** called after every state change */
  onChange?: (state: StateName, via: TransitionKind) => void;
}

export class Mascot {
  state: StateName = 'idle';
  queued: StateName | null = null;

  private players: AnimationItem[] = [];
  private els: HTMLElement[] = [];
  private front = 0;
  private fading = false;
  private fadeMs: number;
  private onChange?: MascotOptions['onChange'];

  constructor(host: HTMLElement, animationData: unknown, player: LottiePlayer, opts: MascotOptions = {}) {
    this.fadeMs = opts.fadeMs ?? 140;
    this.onChange = opts.onChange;
    host.style.position = host.style.position || 'relative';

    // two stacked players: [0] is used for everything, [1] only exists to crossfade into
    for (let i = 0; i < 2; i++) {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;inset:0;transition:opacity 0ms linear';
      el.style.opacity = i === 0 ? '1' : '0';
      host.appendChild(el);
      const item = player.loadAnimation({
        container: el,
        renderer: 'svg',
        loop: true,
        autoplay: false,
        // lottie-web mutates the data it is given, so each player gets its own copy
        animationData: JSON.parse(JSON.stringify(animationData)),
      });
      item.addEventListener('loopComplete', () => this.onLoop(i));
      item.addEventListener('complete', () => this.onComplete(i));
      this.players.push(item);
      this.els.push(el);
    }

    this.enter('idle', 0, 'end');
    if (opts.autoplay === false) this.pause();
  }

  /** current frame inside the active segment */
  get frame(): number {
    return this.players[this.front].currentFrame;
  }

  /** current frame on the whole timeline */
  get absoluteFrame(): number {
    const p = this.players[this.front];
    return p.firstFrame + p.currentFrame;
  }

  go(name: StateName, opts: { urgent?: boolean } = {}): void {
    if (name === this.state && !this.queued) return;
    const from = STATES[this.state];
    const to = STATES[name];

    if (!from.loop || this.fading) {
      // a one-shot (or a fade) is in flight: apply when it ends
      this.queued = name;
      return;
    }
    if (name === this.state) {
      this.queued = null; // back to where we already are: just drop the pending request
      return;
    }
    if (to.loop) {
      this.enter(name, this.frame, 'phase');
    } else if (opts.urgent) {
      this.crossfade(name);
    } else {
      this.queued = name;
    }
  }

  play(): void {
    this.players[this.front].play();
  }

  pause(): void {
    this.players[this.front].pause();
  }

  destroy(): void {
    this.players.forEach((p) => p.destroy());
    this.els.forEach((el) => el.remove());
  }

  // ---------------------------------------------------------------------------

  private onLoop(i: number): void {
    if (i !== this.front || this.fading || !this.queued) return;
    this.enter(this.queued, 0, 'boundary');
  }

  private onComplete(i: number): void {
    if (i !== this.front || this.fading) return;
    this.enter(this.queued ?? STATES[this.state].next ?? 'idle', 0, 'end');
  }

  private enter(name: StateName, phase: number, via: TransitionKind): void {
    const s = STATES[name];
    const p = this.players[this.front];
    this.state = name;
    this.queued = null;
    p.loop = s.loop;
    p.playSegments(s.seg, true);
    if (phase > 0) p.goToAndPlay(Math.min(phase, s.seg[1] - s.seg[0] - 0.01), true);
    this.onChange?.(name, via);
  }

  private crossfade(name: StateName): void {
    const oldIdx = this.front;
    const newIdx = 1 - oldIdx;
    const oldEl = this.els[oldIdx];
    const newEl = this.els[newIdx];

    this.fading = true;
    this.front = newIdx;
    newEl.style.zIndex = '2';
    oldEl.style.zIndex = '1';
    this.enter(name, 0, 'crossfade'); // starts the new player from frame 0, old one keeps moving underneath

    // fade the new one in on top; the old one stays opaque so nothing shows through
    newEl.style.transitionDuration = '0ms';
    newEl.style.opacity = '0';
    void newEl.offsetWidth;
    newEl.style.transitionDuration = `${this.fadeMs}ms`;
    newEl.style.opacity = '1';

    window.setTimeout(() => {
      this.players[oldIdx].pause();
      oldEl.style.transitionDuration = '0ms';
      oldEl.style.opacity = '0';
      this.fading = false;
      // the one-shot may be shorter than the fade only if misconfigured; guard anyway
      if (this.players[newIdx].isPaused && !STATES[this.state].loop) this.onComplete(newIdx);
    }, this.fadeMs + 20);
  }
}
