import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamSupervisorImpl } from '../../src/reliability/supervisor';
import {
  HIDDEN_TEARDOWN_GRACE_MS,
  REMOUNT_BACKOFF_CAP_MS,
  TIER1_MAX_RETRIES,
  TIER1_RETRY_DELAY_MS,
  type HomeAssistant,
  type NormalizedCardConfig,
  type SupervisorState,
  type SupervisorStateDetail,
} from '../../src/types';
import {
  FakePlayer,
  FakeWatchdog,
  RvfcFakeVideo,
  fakeConfig,
  fakeEndpoint,
  fakeHass,
} from './doubles';

/** Let queued microtasks (the per-attempt URL signing) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function harness(configOverrides: Partial<NormalizedCardConfig> = {}) {
  const endpoint = fakeEndpoint();
  const players: FakePlayer[] = [];
  const watchdog = new FakeWatchdog();
  const videoElement = new RvfcFakeVideo();
  const states: { state: SupervisorState; detail?: SupervisorStateDetail }[] = [];
  const reloadPage = vi.fn();
  const info = vi.fn();

  let config = fakeConfig(configOverrides);
  let hass: HomeAssistant | null = fakeHass();
  let video: HTMLVideoElement | null = videoElement.asVideo();
  let onCreate: (player: FakePlayer) => void = () => {};

  const supervisor = new StreamSupervisorImpl({
    createPlayer: () => {
      const player = new FakePlayer();
      onCreate(player);
      players.push(player);
      return player;
    },
    endpoint,
    getHass: () => hass,
    getVideo: () => video,
    getConfig: () => config,
    createWatchdog: watchdog.factory,
    reloadPage,
    // Maximum jitter sample, so the tier-2 sequence is the plain 5/10/20 s one.
    random: () => 1,
    logger: { info },
  });
  supervisor.onStateChange = (state, detail) => states.push({ state, detail });

  return {
    supervisor,
    endpoint,
    players,
    watchdog,
    videoElement,
    states,
    reloadPage,
    info,
    /** Advance fake time and settle the async attempt pipeline. */
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
      await flush();
    },
    /** Settle the async attempt pipeline without advancing time. */
    async settle() {
      await flush();
    },
    /** The most recent player handed to the supervisor. */
    current(): FakePlayer {
      return players[players.length - 1];
    },
    last() {
      return states[states.length - 1];
    },
    names(): SupervisorState[] {
      return states.map((entry) => entry.state);
    },
    setHass(next: HomeAssistant | null) {
      hass = next;
    },
    setVideo(next: HTMLVideoElement | null) {
      video = next;
    },
    setConfig(next: NormalizedCardConfig) {
      config = next;
    },
    /** Mutate every player the factory builds from now on. */
    setOnCreate(fn: (player: FakePlayer) => void) {
      onCreate = fn;
    },
  };
}

/** Drive the supervisor to `playing`. */
async function play(h: ReturnType<typeof harness>): Promise<void> {
  h.supervisor.start();
  await h.settle();
  h.current().reportPlaying();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('happy path', () => {
  it('goes idle -> connecting -> playing, signing a fresh URL for the attempt', async () => {
    const h = harness();

    h.supervisor.start();
    expect(h.names()).toEqual(['connecting']);
    expect(h.last().detail).toEqual({ reason: undefined, attempt: undefined, downForMs: 0 });

    await h.settle();
    expect(h.players).toHaveLength(1);
    expect(h.endpoint.callCount()).toBe(1);
    expect(h.current().mountCount).toBe(1);
    expect(h.current().mountedVideo).toBe(h.videoElement.asVideo());
    expect(h.current().mountedUrl).toContain('authSig=sig-1');

    h.current().reportPlaying();
    expect(h.supervisor.state).toBe('playing');
    expect(h.names()).toEqual(['connecting', 'playing']);
  });

  it('attaches, resets and arms the watchdog once frames flow', async () => {
    const h = harness();

    h.supervisor.start();
    await h.settle();
    expect(h.watchdog.attached).toEqual([h.videoElement.asVideo()]);
    expect(h.watchdog.armCount).toBe(0);
    expect(h.watchdog.playbackExpected()).toBe(false);

    h.current().reportPlaying();
    expect(h.watchdog.resetCount).toBe(1);
    expect(h.watchdog.armCount).toBe(1);
    expect(h.watchdog.playbackExpected()).toBe(true);
  });

  it('ignores repeated onPlaying callbacks', async () => {
    const h = harness();
    await play(h);

    h.current().reportPlaying();
    h.current().reportPlaying();

    expect(h.names()).toEqual(['connecting', 'playing']);
    expect(h.watchdog.armCount).toBe(1);
  });

  it('start() is a no-op while already started', async () => {
    const h = harness();
    h.supervisor.start();
    h.supervisor.start();
    await h.settle();
    expect(h.players).toHaveLength(1);
    expect(h.names()).toEqual(['connecting']);
  });
});

describe('two-tier retry', () => {
  it('does three fast in-place retries, then escalates to backed-off remounts', async () => {
    const h = harness();
    await play(h);

    // Tier 1: three retries, TIER1_RETRY_DELAY_MS apart.
    for (let attempt = 1; attempt <= TIER1_MAX_RETRIES; attempt += 1) {
      h.current().reportDead('ws-close');
      expect(h.last().state).toBe('retrying');
      expect(h.last().detail).toMatchObject({
        reason: 'ws-close',
        attempt,
        delayMs: TIER1_RETRY_DELAY_MS,
      });
      await h.advance(TIER1_RETRY_DELAY_MS);
      expect(h.last().state).toBe('connecting');
    }

    // Tier 2: full replacement, 5 s -> 10 s -> 20 s (jitter pinned at 1.0).
    for (const [attempt, delayMs] of [
      [1, 5_000],
      [2, 10_000],
      [3, 20_000],
    ] as const) {
      h.current().reportDead('media-error');
      expect(h.last().state).toBe('remounting');
      expect(h.last().detail).toMatchObject({ reason: 'media-error', attempt, delayMs });
      await h.advance(delayMs);
      expect(h.last().state).toBe('connecting');
    }

    // Every attempt built a brand-new player and signed a brand-new URL.
    expect(h.players).toHaveLength(7);
    expect(h.endpoint.callCount()).toBe(7);
    expect(new Set(h.endpoint.urls).size).toBe(7);
    expect(h.players[0].destroyCount).toBe(1);
  });

  it('does not fire the retry before its delay elapses', async () => {
    const h = harness();
    await play(h);

    h.current().reportDead('ws-error');
    await h.advance(TIER1_RETRY_DELAY_MS - 1);
    expect(h.players).toHaveLength(1);

    await h.advance(1);
    expect(h.players).toHaveLength(2);
  });

  it('resets both tiers once the stream plays again', async () => {
    const h = harness();
    await play(h);

    // Burn through tier 1 and one tier-2 remount.
    for (let i = 0; i < TIER1_MAX_RETRIES; i += 1) {
      h.current().reportDead('ws-close');
      await h.advance(TIER1_RETRY_DELAY_MS);
    }
    h.current().reportDead('ws-close');
    expect(h.last().state).toBe('remounting');
    await h.advance(5_000);

    h.current().reportPlaying();
    expect(h.supervisor.state).toBe('playing');

    // Back to tier 1 attempt 1, and the backoff starts from the base again.
    h.current().reportDead('ws-close');
    expect(h.last().detail).toMatchObject({ attempt: 1, delayMs: TIER1_RETRY_DELAY_MS });
    for (let i = 0; i < TIER1_MAX_RETRIES - 1; i += 1) {
      await h.advance(TIER1_RETRY_DELAY_MS);
      h.current().reportDead('ws-close');
    }
    await h.advance(TIER1_RETRY_DELAY_MS);
    h.current().reportDead('ws-close');
    expect(h.last().detail).toMatchObject({ attempt: 1, delayMs: 5_000 });
  });

  it('retries forever, capping the delay and never reaching a terminal state', async () => {
    const h = harness();
    await play(h);

    const delays: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      h.current().reportDead('ws-close');
      const detail = h.last().detail;
      expect(['retrying', 'remounting']).toContain(h.last().state);
      expect(detail?.delayMs).toBeGreaterThan(0);
      delays.push(detail?.delayMs ?? 0);
      await h.advance(detail?.delayMs ?? 0);
      expect(h.last().state).toBe('connecting');
    }

    expect(h.players).toHaveLength(31);
    expect(Math.max(...delays)).toBe(REMOUNT_BACKOFF_CAP_MS);
    expect(delays[delays.length - 1]).toBe(REMOUNT_BACKOFF_CAP_MS);
  });

  it('logs every death at info with the reason', async () => {
    const h = harness();
    await play(h);

    h.current().reportDead('handshake-timeout');

    expect(h.info).toHaveBeenCalledWith(
      expect.stringContaining('[simpler-camera-card] stream died: handshake-timeout'),
    );
  });

  it('reports downtime so the card can show a countdown', async () => {
    const h = harness();
    await play(h);

    h.current().reportDead('ws-close');
    expect(h.last().detail?.downForMs).toBe(0);

    await h.advance(TIER1_RETRY_DELAY_MS);
    h.current().reportDead('ws-close');
    expect(h.last().detail?.downForMs).toBe(TIER1_RETRY_DELAY_MS);
  });
});

describe('watchdog stall', () => {
  it('treats a stall as a death and tears the zombie player down', async () => {
    const h = harness();
    await play(h);
    const zombie = h.current();

    h.watchdog.stall();

    expect(zombie.destroyCount).toBe(1);
    expect(h.last().state).toBe('retrying');
    expect(h.last().detail).toMatchObject({ reason: 'stall', attempt: 1 });
    expect(h.watchdog.armed).toBe(false);
    expect(h.watchdog.playbackExpected()).toBe(false);

    await h.advance(TIER1_RETRY_DELAY_MS);
    expect(h.players).toHaveLength(2);
    h.current().reportPlaying();
    expect(h.watchdog.armCount).toBe(2);
  });
});

describe('endpoint failures', () => {
  it('counts a signing failure as a failed attempt and surfaces the message', async () => {
    const h = harness();
    h.endpoint.fail(new Error('Home Assistant refused to sign the path'));

    h.supervisor.start();
    await h.settle();

    expect(h.players).toHaveLength(0);
    expect(h.last().state).toBe('retrying');
    expect(h.last().detail).toMatchObject({
      attempt: 1,
      message: 'Home Assistant refused to sign the path',
    });
  });

  it('recovers as soon as Home Assistant can sign again', async () => {
    const h = harness();
    h.endpoint.fail(new Error('HA is restarting'));
    h.supervisor.start();
    await h.settle();

    h.endpoint.succeed();
    await h.advance(TIER1_RETRY_DELAY_MS);
    h.current().reportPlaying();

    expect(h.supervisor.state).toBe('playing');
  });

  it('treats a missing hass or video element as a failed attempt', async () => {
    const h = harness();
    h.setHass(null);
    h.supervisor.start();
    await h.settle();
    expect(h.last().state).toBe('retrying');
    expect(h.last().detail?.message).toContain('Home Assistant');

    h.setHass(fakeHass());
    h.setVideo(null);
    await h.advance(TIER1_RETRY_DELAY_MS);
    expect(h.last().state).toBe('retrying');
    expect(h.last().detail?.message).toContain('video element');
  });
});

describe('external events', () => {
  it('retries immediately when Home Assistant reconnects mid-backoff', async () => {
    const h = harness();
    await play(h);
    h.current().reportDead('ws-close');
    expect(h.last().detail?.delayMs).toBe(TIER1_RETRY_DELAY_MS);

    h.supervisor.notifyExternalEvent('hass-reconnected');
    await h.settle();

    expect(h.players).toHaveLength(2);
    expect(h.last().state).toBe('connecting');
    expect(h.states[h.states.length - 1].detail).toMatchObject({ reason: 'hass-reconnected' });
  });

  it('resets the backoff on page-resumed, so the next failure starts from the base', async () => {
    const h = harness();
    await play(h);

    // Reach tier 2 with a grown backoff (5 s then 10 s consumed).
    for (let i = 0; i < TIER1_MAX_RETRIES; i += 1) {
      h.current().reportDead('ws-close');
      await h.advance(TIER1_RETRY_DELAY_MS);
    }
    h.current().reportDead('ws-close');
    await h.advance(5_000);
    h.current().reportDead('ws-close');
    expect(h.last().detail?.delayMs).toBe(10_000);

    h.supervisor.notifyExternalEvent('page-resumed');
    await h.settle();
    expect(h.last().state).toBe('connecting');

    h.current().reportDead('ws-close');
    expect(h.last().state).toBe('remounting');
    expect(h.last().detail?.delayMs).toBe(5_000);
  });

  it('does nothing on hass-reconnected while playing', async () => {
    const h = harness();
    await play(h);
    const before = h.states.length;

    h.supervisor.notifyExternalEvent('hass-reconnected');
    h.supervisor.notifyExternalEvent('page-resumed');
    await h.advance(60_000);

    expect(h.supervisor.state).toBe('playing');
    expect(h.states).toHaveLength(before);
    expect(h.players).toHaveLength(1);
    expect(h.current().destroyCount).toBe(0);
  });

  it('tears down after the hidden grace period and parks in idle', async () => {
    const h = harness();
    await play(h);
    const player = h.current();

    h.supervisor.notifyExternalEvent('visibility-hidden');
    await h.advance(HIDDEN_TEARDOWN_GRACE_MS - 1);
    expect(h.supervisor.state).toBe('playing');
    expect(player.destroyCount).toBe(0);

    await h.advance(1);
    expect(h.supervisor.state).toBe('idle');
    expect(h.last().detail?.message).toContain('hidden');
    expect(player.destroyCount).toBe(1);
    expect(h.watchdog.armed).toBe(false);
    expect(h.watchdog.playbackExpected()).toBe(false);
  });

  it('cancels the teardown when the dashboard becomes visible again in time', async () => {
    const h = harness();
    await play(h);

    h.supervisor.notifyExternalEvent('visibility-hidden');
    await h.advance(HIDDEN_TEARDOWN_GRACE_MS - 1);
    h.supervisor.notifyExternalEvent('visibility-visible');
    await h.advance(60_000);

    expect(h.supervisor.state).toBe('playing');
    expect(h.current().destroyCount).toBe(0);
    expect(h.players).toHaveLength(1);
  });

  it('reconnects immediately when the dashboard comes back', async () => {
    const h = harness();
    await play(h);

    h.supervisor.notifyExternalEvent('visibility-hidden');
    await h.advance(HIDDEN_TEARDOWN_GRACE_MS);
    expect(h.supervisor.state).toBe('idle');

    h.supervisor.notifyExternalEvent('visibility-visible');
    await h.settle();

    expect(h.last().state).toBe('connecting');
    expect(h.players).toHaveLength(2);
    h.current().reportPlaying();
    expect(h.supervisor.state).toBe('playing');
  });

  it('ignores retries and events while suspended', async () => {
    const h = harness();
    await play(h);
    h.current().reportDead('ws-close');

    h.supervisor.notifyExternalEvent('visibility-hidden');
    await h.advance(HIDDEN_TEARDOWN_GRACE_MS);
    expect(h.supervisor.state).toBe('idle');

    const before = h.states.length;
    h.supervisor.notifyExternalEvent('hass-reconnected');
    await h.advance(600_000);

    expect(h.states).toHaveLength(before);
    expect(h.players).toHaveLength(2);
  });
});

describe('escape hatch', () => {
  it('reloads the page after the configured continuous downtime', async () => {
    const h = harness({ reload_after_minutes_down: 2 });

    h.supervisor.start();
    await h.advance(2 * 60_000 - 1);
    expect(h.reloadPage).not.toHaveBeenCalled();

    await h.advance(1);
    expect(h.reloadPage).toHaveBeenCalledTimes(1);
  });

  it('never reloads while the stream is healthy', async () => {
    const h = harness({ reload_after_minutes_down: 2 });
    await play(h);

    await h.advance(60 * 60_000);

    expect(h.reloadPage).not.toHaveBeenCalled();
  });

  it('restarts the downtime clock when the stream recovers', async () => {
    const h = harness({ reload_after_minutes_down: 2 });

    h.supervisor.start();
    await h.advance(110_000);
    await h.settle();
    h.current().reportPlaying();

    await h.advance(60_000);
    expect(h.reloadPage).not.toHaveBeenCalled();

    h.current().reportDead('ws-close');
    await h.advance(2 * 60_000);
    expect(h.reloadPage).toHaveBeenCalledTimes(1);
  });

  it('is disabled by default', async () => {
    const h = harness();
    h.supervisor.start();
    await h.advance(6 * 60 * 60_000);
    expect(h.reloadPage).not.toHaveBeenCalled();
  });

  it('does not count downtime that the card asked for by hiding', async () => {
    const h = harness({ reload_after_minutes_down: 2 });
    await play(h);

    h.supervisor.notifyExternalEvent('visibility-hidden');
    await h.advance(HIDDEN_TEARDOWN_GRACE_MS);
    await h.advance(60 * 60_000);

    expect(h.reloadPage).not.toHaveBeenCalled();
  });

  it('does not reload after stop()', async () => {
    const h = harness({ reload_after_minutes_down: 2 });
    h.supervisor.start();
    await h.settle();
    h.supervisor.stop();

    await h.advance(10 * 60_000);
    expect(h.reloadPage).not.toHaveBeenCalled();
  });
});

describe('stop / start', () => {
  it('tears everything down and is idempotent', async () => {
    const h = harness();
    await play(h);
    const player = h.current();

    h.supervisor.stop();
    expect(h.supervisor.state).toBe('idle');
    expect(player.destroyCount).toBe(1);
    expect(h.watchdog.detachCount).toBe(1);

    const after = h.states.length;
    h.supervisor.stop();
    h.supervisor.stop();
    expect(h.states).toHaveLength(after);
    expect(player.destroyCount).toBe(1);
  });

  it('cancels a pending retry', async () => {
    const h = harness();
    await play(h);
    h.current().reportDead('ws-close');

    h.supervisor.stop();
    await h.advance(600_000);

    expect(h.players).toHaveLength(1);
  });

  it('emits nothing when stopped before it was ever started', () => {
    const h = harness();
    h.supervisor.stop();
    expect(h.states).toHaveLength(0);
  });

  it('starts cleanly again after a stop', async () => {
    const h = harness();
    await play(h);

    // Grow the backoff so a leftover would be visible.
    for (let i = 0; i <= TIER1_MAX_RETRIES; i += 1) {
      h.current().reportDead('ws-close');
      await h.advance(h.last().detail?.delayMs ?? 0);
    }
    h.supervisor.stop();

    h.supervisor.start();
    await h.settle();
    expect(h.last().state).toBe('connecting');
    h.current().reportPlaying();
    expect(h.supervisor.state).toBe('playing');

    h.current().reportDead('ws-close');
    expect(h.last().detail).toMatchObject({ attempt: 1, delayMs: TIER1_RETRY_DELAY_MS });
  });

  it('drops an in-flight attempt whose URL arrives after stop()', async () => {
    const h = harness();
    h.supervisor.start();
    h.supervisor.stop();
    await h.settle();

    expect(h.players).toHaveLength(0);
    expect(h.supervisor.state).toBe('idle');
  });
});

describe('defensive behaviour', () => {
  it('ignores callbacks from a player it has already discarded', async () => {
    const h = harness();
    await play(h);
    const zombie = h.current();

    zombie.reportDead('ws-close');
    const after = h.states.length;
    const players = h.players.length;

    // A misbehaving player firing again after destroy() must change nothing.
    zombie.reportFromZombie('media-error');

    expect(h.states).toHaveLength(after);
    expect(h.players).toHaveLength(players);
    expect(h.last().state).toBe('retrying');
    expect(h.last().detail).toMatchObject({ attempt: 1 });
  });

  it('survives a player whose mount() throws', async () => {
    const h = harness();
    h.setOnCreate((player) => {
      player.mount = () => {
        throw new Error('MediaSource is not supported');
      };
    });

    h.supervisor.start();
    await h.settle();

    expect(h.last().state).toBe('retrying');
    expect(h.last().detail?.message).toContain('MediaSource');
    expect(h.players[0].destroyCount).toBe(1);
  });
});
