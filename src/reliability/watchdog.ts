/**
 * `reliability/watchdog.ts` — the frame-stall watchdog.
 *
 * This is the detector no other camera card has. Nothing in the chain from
 * Frigate's go2rtc to the browser sends a keepalive (go2rtc has no pings, HA's
 * websocket proxy sets `autoping=False`), so a blackholed TCP path produces
 * *no* client-side event for minutes: the WebSocket stays "open", the
 * `RTCPeerConnection` stays "connected", and the picture is simply frozen. The
 * only reliable signal is the one thing the user actually cares about — are
 * frames still being presented?
 *
 * Design rules, borrowed from Advanced Camera Card v8.0.0-rc.4's
 * `FrameStallWatchdog` (MIT, designed but never wired up in that project):
 *
 * - **Detector, never recovery driver.** The watchdog reports a stall and stops.
 *   It never tears anything down, never retries, and never re-fires. The
 *   verdict is *held* until {@link FrameStallWatchdog.reset} is called after a
 *   successful recovery, which is what stops a frozen stream from generating a
 *   flap loop of stall → remount → stall.
 * - **Gate on expected playback.** Browsers legitimately stop presenting frames
 *   when the element is paused, seeking, or the tab is hidden. Firing then would
 *   be a false positive, so the timer is only allowed to convict while the
 *   supervisor says playback is expected *and* the element agrees.
 *
 * Primary signal is `requestVideoFrameCallback` (Chromium, the primary target);
 * where it is missing the fallback watches `currentTime` advance via a 1 s poll
 * plus the `timeupdate` event, gated identically.
 */

import { WATCHDOG_STALL_TIMEOUT_MS } from '../types';
import { defaultTimers, type TimerApi, type TimerHandle } from './retry';

/**
 * Fallback poll period, used only when `requestVideoFrameCallback` is missing.
 *
 * One second: a tenth of the stall timeout, so at most 10 % of the window is
 * lost to poll granularity, while costing one property read per second. The
 * `timeupdate` event (fired ~4×/s during playback) is watched too, so the poll
 * is really just insurance for engines that batch or suppress it.
 */
export const WATCHDOG_POLL_INTERVAL_MS = 1_000;

/** The watchdog surface the supervisor depends on (mocked wholesale in tests). */
export interface StallWatchdog {
  /** Watch this element. Detaches from any previously attached element. */
  attach(video: HTMLVideoElement): void;
  /** Begin (or resume) watching for stalls. */
  arm(): void;
  /** Stop watching. Does not clear a held stall verdict. */
  disarm(): void;
  /** Clear a held stall verdict after a recovery. */
  reset(): void;
  /** Stop watching and drop all listeners on the current element. */
  detach(): void;
  /** Permanent teardown. */
  destroy(): void;
}

/** Construction options for {@link FrameStallWatchdog}. */
export interface WatchdogOptions {
  /**
   * Called exactly once per stall verdict. Must not throw; the watchdog does
   * nothing else in response (see the "detector, never recovery driver" rule).
   */
  onStall: () => void;
  /**
   * The supervisor's gate: is playback expected right now? Typically
   * "state is `playing` and the dashboard is visible". Defaults to `true`, so
   * the element's own `paused`/`seeking`/`ended` flags are the only gate.
   */
  isPlaybackExpected?: () => boolean;
  /** Stall window. Defaults to {@link WATCHDOG_STALL_TIMEOUT_MS} (10 s). */
  timeoutMs?: number;
  /** Fallback poll period. Defaults to {@link WATCHDOG_POLL_INTERVAL_MS} (1 s). */
  pollIntervalMs?: number;
  /** Injectable timers; defaults to the real ones (resolved per call). */
  timers?: TimerApi;
  /**
   * Monotonic-enough clock in milliseconds. Defaults to `Date.now`, read per
   * call so `vi.useFakeTimers()` (which fakes `Date` too) drives it.
   */
  now?: () => number;
}

/** `requestVideoFrameCallback` bound to an element, or `null` where unsupported. */
function frameCallbackApi(video: HTMLVideoElement): {
  request(callback: () => void): number;
  cancel(handle: number): void;
} | null {
  const target = video as unknown as Record<string, unknown>;
  const request = target.requestVideoFrameCallback;
  const cancel = target.cancelVideoFrameCallback;
  if (typeof request !== 'function') return null;
  return {
    request: (callback) => (request as (cb: () => void) => number).call(video, callback),
    cancel: (handle) => {
      if (typeof cancel === 'function') {
        (cancel as (h: number) => void).call(video, handle);
      }
    },
  };
}

/**
 * Frame-stall watchdog: no presented frame for `timeoutMs` while playback is
 * expected ⇒ the stream is dead, whatever the transport claims.
 *
 * Lifecycle: `attach(video)` → `arm()` → (stall ⇒ `onStall()` once) →
 * `reset()` + `arm()` after recovery → `detach()` / `destroy()`.
 */
export class FrameStallWatchdog implements StallWatchdog {
  private readonly onStall: () => void;
  private readonly isPlaybackExpected: () => boolean;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly timers: TimerApi;
  private readonly now: () => number;

  private video: HTMLVideoElement | null = null;
  private armedFlag = false;
  private stalledFlag = false;
  private destroyed = false;

  private stallHandle: TimerHandle | null = null;
  private pollHandle: TimerHandle | null = null;
  private frames: ReturnType<typeof frameCallbackApi> = null;
  private frameHandle: number | null = null;
  private lastCurrentTime = 0;

  /**
   * When the last sign of life arrived (or when observation started).
   *
   * This — not a re-armed timer — is what a presented frame updates, which is
   * the whole point: frames arrive ~30 times a second per camera, all day, and
   * a `clearTimeout`/`setTimeout` pair on each one is pure churn. See
   * {@link armStallTimer} for the timer that chases it.
   */
  private lastProgressAt = 0;
  private readonly onProgressEvent = () => this.checkProgress();

  constructor(options: WatchdogOptions) {
    this.onStall = options.onStall;
    this.isPlaybackExpected = options.isPlaybackExpected ?? (() => true);
    this.timeoutMs = options.timeoutMs ?? WATCHDOG_STALL_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? WATCHDOG_POLL_INTERVAL_MS;
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? ((): number => Date.now());
  }

  /** Whether the watchdog is currently watching for stalls. */
  get armed(): boolean {
    return this.armedFlag;
  }

  /** Whether a stall verdict is being held (cleared only by {@link reset}). */
  get stalled(): boolean {
    return this.stalledFlag;
  }

  /** True when the primary `requestVideoFrameCallback` signal is in use. */
  get usingFrameCallbacks(): boolean {
    return this.frames !== null;
  }

  attach(video: HTMLVideoElement): void {
    if (this.destroyed) return;
    if (this.video === video) return;
    const wasArmed = this.armedFlag;
    this.stopObserving();
    this.video = video;
    if (wasArmed) this.startObserving();
  }

  arm(): void {
    if (this.destroyed || this.armedFlag) return;
    this.armedFlag = true;
    this.stalledFlag = false;
    this.startObserving();
  }

  disarm(): void {
    this.armedFlag = false;
    this.stopObserving();
  }

  reset(): void {
    this.stalledFlag = false;
    if (this.armedFlag) {
      this.stopObserving();
      this.startObserving();
    }
  }

  detach(): void {
    this.disarm();
    this.stalledFlag = false;
    this.video = null;
  }

  destroy(): void {
    this.detach();
    this.destroyed = true;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private startObserving(): void {
    const video = this.video;
    if (!video || !this.armedFlag || this.destroyed) return;

    this.lastCurrentTime = video.currentTime;
    this.noteProgress();
    this.armStallTimer(this.timeoutMs);

    this.frames = frameCallbackApi(video);
    if (this.frames) {
      this.requestFrame();
      return;
    }

    // Fallback: `currentTime` deltas, sampled by both a poll and `timeupdate`.
    video.addEventListener('timeupdate', this.onProgressEvent);
    this.pollHandle = this.timers.setInterval(this.onProgressEvent, this.pollIntervalMs);
  }

  private stopObserving(): void {
    if (this.stallHandle !== null) {
      this.timers.clearTimeout(this.stallHandle);
      this.stallHandle = null;
    }
    if (this.pollHandle !== null) {
      this.timers.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.frames && this.frameHandle !== null) {
      this.frames.cancel(this.frameHandle);
    }
    this.frameHandle = null;
    this.frames = null;
    this.video?.removeEventListener('timeupdate', this.onProgressEvent);
  }

  private requestFrame(): void {
    const frames = this.frames;
    if (!frames || !this.armedFlag || this.stalledFlag || this.destroyed) return;
    this.frameHandle = frames.request(() => {
      this.frameHandle = null;
      this.onFramePresented();
    });
  }

  /**
   * A frame reached the screen: the stream is demonstrably alive.
   *
   * Deliberately as cheap as it looks — one clock read and two field writes.
   * This runs once per presented frame (~30 Hz per camera, forever), so it must
   * not touch a timer; {@link onStallTimeout} does the arithmetic instead, at
   * most once per stall window.
   */
  private onFramePresented(): void {
    if (!this.armedFlag || this.stalledFlag || this.destroyed) return;
    if (this.video) this.lastCurrentTime = this.video.currentTime;
    this.noteProgress();
    this.requestFrame();
  }

  /** Fallback signal: treat any `currentTime` advance as a presented frame. */
  private checkProgress(): void {
    const video = this.video;
    if (!video || !this.armedFlag || this.stalledFlag || this.destroyed) return;
    if (video.currentTime !== this.lastCurrentTime) {
      this.lastCurrentTime = video.currentTime;
      this.noteProgress();
    }
  }

  /** Record a sign of life. The only thing the per-frame path writes. */
  private noteProgress(): void {
    this.lastProgressAt = this.now();
  }

  private armStallTimer(delayMs: number): void {
    if (this.stallHandle !== null) {
      this.timers.clearTimeout(this.stallHandle);
    }
    this.stallHandle = this.timers.setTimeout(() => this.onStallTimeout(), delayMs);
  }

  /**
   * The deadline came round: is it really a stall?
   *
   * The timer chases {@link lastProgressAt} rather than being reset by it. If
   * frames have arrived since it was armed it simply re-arms itself for the
   * remainder of *their* window, which keeps the verdict landing at exactly
   * `timeoutMs` after the last frame — the same instant the old re-arm-per-frame
   * version convicted at — while costing one timer per window instead of one
   * per frame.
   */
  private onStallTimeout(): void {
    this.stallHandle = null;
    if (!this.armedFlag || this.stalledFlag || this.destroyed) return;

    let sinceProgress = this.now() - this.lastProgressAt;
    if (sinceProgress < 0) {
      // `Date.now()` is wall-clock, not monotonic: an NTP correction or a
      // resumed laptop can step it backwards. Start a fresh window from here
      // rather than going blind until the clock catches up.
      this.noteProgress();
      sinceProgress = 0;
    }
    if (sinceProgress < this.timeoutMs) {
      // A frame landed after this timer was armed: the window has moved.
      this.armStallTimer(this.timeoutMs - sinceProgress);
      return;
    }

    if (!this.playbackIsExpected()) {
      // Not a stall: nobody expected a frame. Keep waiting, silently.
      this.armStallTimer(this.timeoutMs);
      return;
    }

    // Held verdict: stop observing and never fire again until `reset()`.
    this.stalledFlag = true;
    this.armedFlag = false;
    this.stopObserving();
    this.onStall();
  }

  private playbackIsExpected(): boolean {
    const video = this.video;
    if (!video) return false;
    if (!this.isPlaybackExpected()) return false;
    return !video.paused && !video.seeking && !video.ended;
  }
}
