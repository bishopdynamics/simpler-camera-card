/**
 * `snapshot.ts` — the polled-stills loop.
 *
 * Time is faked throughout and the preload element is injected, so every test
 * drives the exact sequence it is about: when the timer fires, when a
 * resolution settles, and when (or whether) an image decodes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EndpointError } from '../src/endpoint';
import {
  SNAPSHOT_TICK_TIMEOUT_FLOOR_MS,
  SnapshotLoop,
  type SnapshotLoopDeps,
} from '../src/snapshot';
import {
  SNAPSHOT_STALE_AFTER_FAILURES,
  type EndpointResolver,
  type HomeAssistant,
  type NormalizedCardConfig,
} from '../src/types';

/* -------------------------------------------------------------------------- */
/* Doubles                                                                     */
/* -------------------------------------------------------------------------- */

/** What a preloaded image should do when its `src` is assigned. */
type ImageBehaviour = 'load' | 'error' | 'hold';

/** The parts of `HTMLImageElement` the loop touches. */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  behaviour: ImageBehaviour = 'load';
  private value = '';

  get src(): string {
    return this.value;
  }

  set src(next: string) {
    this.value = next;
    if (next === '') return;
    if (this.behaviour === 'load') queueMicrotask(() => this.onload?.());
    else if (this.behaviour === 'error') queueMicrotask(() => this.onerror?.());
  }

  /** Decode now — for `hold`, where the test says when. */
  finishLoad(): void {
    this.onload?.();
  }

  /** Fail now — for `hold`. */
  finishError(): void {
    this.onerror?.();
  }

  asImage(): HTMLImageElement {
    return this as unknown as HTMLImageElement;
  }
}

function fakeConfig(overrides: Partial<NormalizedCardConfig> = {}): NormalizedCardConfig {
  return {
    type: 'custom:simpler-camera-card',
    camera: 'camera.front_yard',
    overlay: 'none',
    tap_action: { action: 'more-info' },
    hold_action: { action: 'none' },
    double_tap_action: { action: 'none' },
    aspect_ratio: '16 / 9',
    reload_after_minutes_down: 0,
    mode: 'snapshot',
    refresh_interval: 5,
    tap_to_live: false,
    live_duration: 60,
    ...overrides,
  };
}

function fakeHass(): HomeAssistant {
  return {
    states: {},
    connected: true,
    connection: {} as HomeAssistant['connection'],
    callWS: (async () => ({})) as unknown as HomeAssistant['callWS'],
  };
}

interface Harness {
  loop: SnapshotLoop;
  /** Every URL handed to `onFrame`, oldest first. */
  frames: string[];
  /** Every failure count reported to `onStale`. */
  stale: number[];
  /** Every error reported to `onEndpointError`. */
  errors: unknown[];
  /** One entry per preload the loop started, oldest first. */
  images: FakeImage[];
  /** How many times a snapshot URL was requested (one per tick). */
  resolveCalls: () => number;
  /** What the next preloads do. */
  setImageBehaviour: (behaviour: ImageBehaviour) => void;
  /** Replace the resolver's behaviour mid-test. */
  setResolver: (resolve: () => Promise<string | null>) => void;
}

function harness(
  options: {
    config?: Partial<NormalizedCardConfig>;
    hass?: () => HomeAssistant | null | undefined;
    deps?: Partial<SnapshotLoopDeps>;
  } = {},
): Harness {
  const frames: string[] = [];
  const stale: number[] = [];
  const errors: unknown[] = [];
  const images: FakeImage[] = [];
  let calls = 0;
  let behaviour: ImageBehaviour = 'load';
  let resolve: () => Promise<string | null> = async () => `/api/camera_proxy/front?sig=${calls}`;

  const endpoint: EndpointResolver = {
    resolveSignedWsUrl: async () => {
      throw new Error('snapshot mode must never sign a websocket URL');
    },
    resolvePosterUrl: async () => {
      calls += 1;
      return resolve();
    },
  };

  const loop = new SnapshotLoop({
    endpoint,
    getHass: options.hass ?? fakeHass,
    getConfig: () => fakeConfig(options.config),
    onFrame: (url) => frames.push(url),
    onStale: (count) => stale.push(count),
    onEndpointError: (error) => errors.push(error),
    createImage: () => {
      const image = new FakeImage();
      image.behaviour = behaviour;
      images.push(image);
      return image.asImage();
    },
    logger: { info: () => {} },
    ...options.deps,
  });

  return {
    loop,
    frames,
    stale,
    errors,
    images,
    resolveCalls: () => calls,
    setImageBehaviour: (next) => {
      behaviour = next;
    },
    setResolver: (next) => {
      resolve = next;
    },
  };
}

/** Let every pending promise settle without moving the clock. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* Cadence                                                                     */
/* -------------------------------------------------------------------------- */

describe('SnapshotLoop — cadence', () => {
  it('polls immediately, then once per refresh_interval', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 4 } });

    h.loop.start();
    await flush();
    expect(h.frames).toEqual(['/api/camera_proxy/front?sig=1']);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(h.frames).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.frames).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(4_000 * 3);
    expect(h.frames).toHaveLength(5);
  });

  it('honours a fractional interval', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 2.5 } });

    h.loop.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(h.frames).toHaveLength(3);
  });

  it('is idempotent: a second start does not double the cadence', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });

    h.loop.start();
    h.loop.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.resolveCalls()).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Preload-then-swap                                                           */
/* -------------------------------------------------------------------------- */

describe('SnapshotLoop — preload before swap', () => {
  it('publishes a frame only once the image has decoded', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.setImageBehaviour('hold');

    h.loop.start();
    await flush();

    // The URL is resolved and the preload is in flight — but nothing is shown.
    expect(h.images).toHaveLength(1);
    expect(h.frames).toEqual([]);

    h.images[0].finishLoad();
    await flush();
    expect(h.frames).toEqual(['/api/camera_proxy/front?sig=1']);
  });

  it('preloads the very URL it then publishes', async () => {
    vi.useFakeTimers();
    const h = harness();

    h.loop.start();
    await flush();

    expect(h.images[0].src).toBe(h.frames[0]);
  });
});

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

describe('SnapshotLoop — failure policy', () => {
  it('goes stale at exactly three consecutive failures, then on every one after', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });
    h.setImageBehaviour('error');

    h.loop.start();
    await flush();
    expect(h.stale).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.stale).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.stale).toEqual([SNAPSHOT_STALE_AFTER_FAILURES]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.stale).toEqual([3, 4]);
    expect(h.frames).toEqual([]);
  });

  it('resets the counter on a good frame', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });
    h.setImageBehaviour('error');

    h.loop.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.loop.consecutiveFailures).toBe(2);

    h.setImageBehaviour('load');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.loop.consecutiveFailures).toBe(0);

    // Two more failures must not reach the threshold: the run was broken.
    h.setImageBehaviour('error');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.stale).toEqual([]);
  });

  it('counts a null snapshot URL as a failure and keeps polling', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });
    h.setResolver(async () => null);

    h.loop.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.stale).toEqual([3]);

    h.setResolver(async () => '/api/camera_proxy/front?sig=recovered');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.frames).toEqual(['/api/camera_proxy/front?sig=recovered']);
  });

  it('counts a missing hass as a failure without throwing', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 }, hass: () => undefined });

    h.loop.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.stale).toEqual([3]);
    expect(h.resolveCalls()).toBe(0);
  });

  it('surfaces an EndpointError and keeps ticking forever', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });
    const failure = new EndpointError('entity-not-found', 'Camera entity was not found.');
    h.setResolver(() => Promise.reject(failure));

    h.loop.start();
    await flush();
    expect(h.errors).toEqual([failure]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.errors).toHaveLength(11);
    expect(h.stale[h.stale.length - 1]).toBe(11);

    // The entity came back: no restart, no human, just the next tick.
    h.setResolver(async () => '/api/camera_proxy/front?sig=back');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.frames).toEqual(['/api/camera_proxy/front?sig=back']);
    expect(h.loop.consecutiveFailures).toBe(0);
  });

  it('treats a non-EndpointError rejection as a plain dropped poll', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });
    h.setResolver(() => Promise.reject(new Error('network down')));

    h.loop.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.errors).toEqual([]);
    expect(h.stale).toEqual([3]);
  });
});

/* -------------------------------------------------------------------------- */
/* Overlap guard                                                               */
/* -------------------------------------------------------------------------- */

describe('SnapshotLoop — overlap guard', () => {
  it('drops timer firings while a tick is still in flight', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });
    h.setResolver(() => new Promise<string>(() => {}));

    h.loop.start();
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);

    // Five interval firings, one outstanding poll.
    expect(h.resolveCalls()).toBe(1);
  });

  it('drops firings while a preload is still decoding, then recovers', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });
    h.setImageBehaviour('hold');

    h.loop.start();
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.images).toHaveLength(1);

    h.setImageBehaviour('load');
    h.images[0].finishLoad();
    await flush();
    expect(h.frames).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.frames).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Tick deadline                                                               */
/* -------------------------------------------------------------------------- */

describe('SnapshotLoop — tick deadline', () => {
  // `refresh_interval: 3` keeps the interval's firings (3 s, 6 s, 9 s, 12 s…)
  // clear of the 10 s deadline, so no assertion depends on which of two timers
  // due at the same instant the fake clock runs first.
  const interval = { refresh_interval: 3 };

  it('abandons a preload that never settles, counts it, and keeps polling', async () => {
    vi.useFakeTimers();
    const h = harness({ config: interval });
    // The reverse proxy accepted the image request and will never answer:
    // neither `onload` nor `onerror` is ever going to fire.
    h.setImageBehaviour('hold');

    h.loop.start();
    await flush();
    expect(h.images).toHaveLength(1);

    // Inside the deadline the overlap guard drops every firing, as it should.
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TICK_TIMEOUT_FLOOR_MS - 1_000);
    expect(h.resolveCalls()).toBe(1);
    expect(h.loop.consecutiveFailures).toBe(0);

    // At the deadline the tick is abandoned: the fetch is dropped and the
    // failure lands in the same counter as every other dropped poll.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.loop.consecutiveFailures).toBe(1);
    expect(h.images[0].src).toBe('');
    expect(h.frames).toEqual([]);

    // …and the loop is polling again on the next firing.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.resolveCalls()).toBe(2);
  });

  it('abandons a resolution that never settles', async () => {
    vi.useFakeTimers();
    const h = harness({ config: interval });
    h.setResolver(() => new Promise<string>(() => {}));

    h.loop.start();
    await flush();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TICK_TIMEOUT_FLOOR_MS);
    expect(h.loop.consecutiveFailures).toBe(1);

    h.setResolver(async () => '/api/camera_proxy/front?sig=recovered');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.frames).toEqual(['/api/camera_proxy/front?sig=recovered']);
    expect(h.loop.consecutiveFailures).toBe(0);
  });

  it('goes stale when nothing ever settles, instead of showing the last still forever', async () => {
    vi.useFakeTimers();
    const h = harness({ config: interval });
    h.setImageBehaviour('hold');

    h.loop.start();
    // Each tick costs its full deadline, then the next firing starts another:
    // abandoned at 10 s, 22 s, 34 s. The third is the one that goes stale.
    await vi.advanceTimersByTimeAsync(34_000);

    expect(h.stale).toEqual([SNAPSHOT_STALE_AFTER_FAILURES]);
    expect(h.frames).toEqual([]);
  });

  it('gives a long refresh_interval a deadline of one interval', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 30 } });
    h.setImageBehaviour('hold');

    h.loop.start();
    await flush();

    // A 30 s poll is not late at 29 s, whatever the floor says.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(h.loop.consecutiveFailures).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.loop.consecutiveFailures).toBe(1);
  });

  it('does not let an abandoned tick release the guard a live tick holds', async () => {
    vi.useFakeTimers();
    const h = harness({ config: interval });
    const pending: ((url: string) => void)[] = [];
    h.setResolver(() => new Promise<string>((resolve) => pending.push(resolve)));

    h.loop.start();
    await flush();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TICK_TIMEOUT_FLOOR_MS);
    expect(h.resolveCalls()).toBe(1);

    // The next firing starts a second tick, which is now the guard's owner.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.resolveCalls()).toBe(2);

    // The abandoned first poll finally lands: no frame, and no meddling with
    // the tick that took its place.
    pending[0]('/api/camera_proxy/front?sig=stale');
    await flush();
    expect(h.frames).toEqual([]);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.resolveCalls()).toBe(2);
  });

  it('cancels the deadline with the tick it belongs to', async () => {
    vi.useFakeTimers();
    const h = harness({ config: interval });
    h.setImageBehaviour('hold');

    h.loop.start();
    await flush();
    h.loop.destroy();

    // A destroyed loop reports nothing, deadline or not.
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TICK_TIMEOUT_FLOOR_MS * 2);
    expect(h.stale).toEqual([]);
    expect(h.loop.consecutiveFailures).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Pause / resume / refresh                                                    */
/* -------------------------------------------------------------------------- */

describe('SnapshotLoop — pause, resume and refreshNow', () => {
  it('stops polling while paused and polls immediately on resume', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });

    h.loop.start();
    await flush();
    expect(h.frames).toHaveLength(1);

    h.loop.pause();
    expect(h.loop.isPaused).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.frames).toHaveLength(1);

    h.loop.resume();
    await flush();
    expect(h.loop.isPaused).toBe(false);
    expect(h.frames).toHaveLength(2);

    // …and the interval is running again from the moment of the resume.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.frames).toHaveLength(3);
  });

  it('abandons the tick in flight when paused', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });
    h.setImageBehaviour('hold');

    h.loop.start();
    await flush();
    h.loop.pause();

    // The preload was cancelled; a late decode must not reach the card.
    h.images[0].finishLoad();
    await flush();
    expect(h.frames).toEqual([]);

    // …and the abandoned tick did not leave the overlap guard stuck.
    h.setImageBehaviour('load');
    h.loop.resume();
    await flush();
    expect(h.frames).toHaveLength(1);
  });

  it('refreshNow polls at once and restarts the interval, but not while paused', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 10 } });

    h.loop.start();
    await flush();
    expect(h.frames).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(6_000);
    h.loop.refreshNow();
    await flush();
    expect(h.frames).toHaveLength(2);

    // The interval restarted at the refresh, so the old deadline passes quietly.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.frames).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.frames).toHaveLength(3);

    h.loop.pause();
    h.loop.refreshNow();
    await flush();
    expect(h.frames).toHaveLength(3);
  });

  it('does nothing before start()', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });

    h.loop.pause();
    h.loop.resume();
    h.loop.refreshNow();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.resolveCalls()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Destroy                                                                     */
/* -------------------------------------------------------------------------- */

describe('SnapshotLoop — destroy', () => {
  it('cancels the timer and is idempotent', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });

    h.loop.start();
    await flush();
    expect(h.resolveCalls()).toBe(1);

    h.loop.destroy();
    h.loop.destroy();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.resolveCalls()).toBe(1);
    expect(h.frames).toHaveLength(1);
  });

  it('makes the callbacks of an in-flight tick no-ops', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });
    h.setImageBehaviour('hold');

    h.loop.start();
    await flush();
    h.loop.destroy();

    h.images[0].finishLoad();
    h.images[0].finishError();
    await flush();

    expect(h.frames).toEqual([]);
    expect(h.stale).toEqual([]);
  });

  it('cannot be restarted, paused or refreshed after destroy', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { refresh_interval: 1 } });

    h.loop.destroy();
    h.loop.start();
    h.loop.resume();
    h.loop.refreshNow();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.resolveCalls()).toBe(0);
  });
});
