/**
 * Shared test doubles for the reliability layer.
 *
 * The player, the endpoint resolver and the `<video>` element are all mocked
 * here against the contract in `src/types.ts`: the reliability layer's tests
 * never touch a real socket, a real MediaSource, or a real DOM media element.
 */

import type {
  DeathReason,
  EndpointResolver,
  HomeAssistant,
  LivePlayer,
  NormalizedCardConfig,
} from '../../src/types';
import type { StallWatchdog, WatchdogOptions } from '../../src/reliability/watchdog';

/* -------------------------------------------------------------------------- */
/* Player                                                                      */
/* -------------------------------------------------------------------------- */

/** A one-shot {@link LivePlayer} that records what was done to it. */
export class FakePlayer implements LivePlayer {
  onPlaying: () => void = () => {};
  onDead: (reason: DeathReason) => void = () => {};

  mountedVideo: HTMLVideoElement | null = null;
  mountedUrl: string | null = null;
  mountCount = 0;
  destroyCount = 0;

  /** The callbacks as they were at `mount()` time — used to simulate a zombie. */
  private capturedOnPlaying: () => void = () => {};
  private capturedOnDead: (reason: DeathReason) => void = () => {};

  mount(video: HTMLVideoElement, signedWsUrl: string): void {
    this.mountCount += 1;
    this.mountedVideo = video;
    this.mountedUrl = signedWsUrl;
    this.capturedOnPlaying = this.onPlaying;
    this.capturedOnDead = this.onDead;
  }

  destroy(): void {
    this.destroyCount += 1;
  }

  /** Report first frame, the way a real player would. */
  reportPlaying(): void {
    this.onPlaying();
  }

  /** Report death, the way a real player would. */
  reportDead(reason: DeathReason): void {
    this.onDead(reason);
  }

  /**
   * Fire the callbacks this player was handed at `mount()`, even after the
   * supervisor has discarded it. Real players must not do this — the point is
   * that the supervisor survives one that does.
   */
  reportFromZombie(reason: DeathReason): void {
    this.capturedOnPlaying();
    this.capturedOnDead(reason);
  }
}

/* -------------------------------------------------------------------------- */
/* Watchdog                                                                    */
/* -------------------------------------------------------------------------- */

/** A {@link StallWatchdog} the test drives by hand. */
export class FakeWatchdog implements StallWatchdog {
  options: WatchdogOptions | null = null;
  readonly attached: HTMLVideoElement[] = [];
  armCount = 0;
  disarmCount = 0;
  resetCount = 0;
  detachCount = 0;
  destroyCount = 0;
  armed = false;

  /** Used as the `createWatchdog` factory. */
  readonly factory = (options: WatchdogOptions): StallWatchdog => {
    this.options = options;
    return this;
  };

  attach(video: HTMLVideoElement): void {
    this.attached.push(video);
  }
  arm(): void {
    this.armCount += 1;
    this.armed = true;
  }
  disarm(): void {
    this.disarmCount += 1;
    this.armed = false;
  }
  reset(): void {
    this.resetCount += 1;
  }
  detach(): void {
    this.detachCount += 1;
    // The real watchdog disarms as part of detaching; the double must too, or
    // it would let a supervisor bug through that production would not have.
    this.disarm();
  }
  destroy(): void {
    this.destroyCount += 1;
  }

  /** Simulate the frame-stall verdict. */
  stall(): void {
    this.options?.onStall();
  }

  /** Ask the supervisor's gate whether frames are expected right now. */
  playbackExpected(): boolean {
    return this.options?.isPlaybackExpected?.() ?? true;
  }
}

/* -------------------------------------------------------------------------- */
/* Video element                                                               */
/* -------------------------------------------------------------------------- */

type Listener = (event?: unknown) => void;

/** The parts of `HTMLVideoElement` the watchdog touches. */
class FakeVideoBase {
  currentTime = 0;
  paused = false;
  seeking = false;
  ended = false;

  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** How many listeners are registered for a type (leak assertions). */
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** Dispatch a bare event, e.g. `timeupdate`. */
  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  /** Advance playback by `seconds` without announcing it. */
  advancePlayback(seconds: number): void {
    this.currentTime += seconds;
  }

  asVideo(): HTMLVideoElement {
    return this as unknown as HTMLVideoElement;
  }
}

/** A video element that supports `requestVideoFrameCallback` (Chromium). */
export class RvfcFakeVideo extends FakeVideoBase {
  private pending = new Map<number, () => void>();
  private nextHandle = 1;
  requestCount = 0;
  cancelCount = 0;

  requestVideoFrameCallback(callback: () => void): number {
    this.requestCount += 1;
    const handle = this.nextHandle++;
    this.pending.set(handle, callback);
    return handle;
  }

  cancelVideoFrameCallback(handle: number): void {
    this.cancelCount += 1;
    this.pending.delete(handle);
  }

  /** Present one frame: advance the clock and run the pending callbacks. */
  presentFrame(seconds = 1 / 30): void {
    this.currentTime += seconds;
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback();
  }

  get pendingFrameCallbacks(): number {
    return this.pending.size;
  }
}

/** A video element without `requestVideoFrameCallback` (fallback path). */
export class PollingFakeVideo extends FakeVideoBase {}

/* -------------------------------------------------------------------------- */
/* Home Assistant + endpoint + config                                          */
/* -------------------------------------------------------------------------- */

/** A `hass` stub; the supervisor only passes it through to the resolver. */
export function fakeHass(): HomeAssistant {
  return {
    states: {},
    connected: true,
    callWS: (async () => ({})) as unknown as HomeAssistant['callWS'],
  };
}

/** An {@link EndpointResolver} whose failure mode the test controls. */
export interface FakeEndpoint extends EndpointResolver {
  /** Make every subsequent resolution reject with `error`. */
  fail(error: unknown): void;
  /** Resolve normally again. */
  succeed(): void;
  /** How many times a signed URL was requested (one per attempt, never cached). */
  callCount(): number;
  /** The URLs handed out so far, newest last. */
  readonly urls: string[];
}

/** A resolver that mints a distinct signed URL per call. */
export function fakeEndpoint(): FakeEndpoint {
  let failure: unknown = null;
  let calls = 0;
  const urls: string[] = [];
  return {
    async resolveSignedWsUrl() {
      calls += 1;
      if (failure) throw failure;
      const url = `wss://ha.local/api/frigate/f/go2rtc/ws/api/ws?src=front&authSig=sig-${calls}`;
      urls.push(url);
      return url;
    },
    async resolvePosterUrl() {
      return null;
    },
    fail(error: unknown) {
      failure = error;
    },
    succeed() {
      failure = null;
    },
    callCount: () => calls,
    urls,
  };
}

/**
 * A normalized config shaped like `normalizeConfig()`'s output. `tap_action`
 * is set explicitly (not the `none` default) so gesture-adjacent code under
 * test always has something to fire; every other field matches its default.
 */
export function fakeConfig(overrides: Partial<NormalizedCardConfig> = {}): NormalizedCardConfig {
  return {
    type: 'custom:simpler-camera-card',
    camera: 'camera.front_yard',
    overlay: 'none',
    tap_action: { action: 'more-info' },
    hold_action: { action: 'none' },
    double_tap_action: { action: 'none' },
    aspect_ratio: '16 / 9',
    reload_after_minutes_down: 0,
    mode: 'live',
    refresh_interval: 5,
    tap_to_live: false,
    live_duration: 60,
    ...overrides,
  };
}
