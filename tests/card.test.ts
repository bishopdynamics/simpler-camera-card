import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOUBLE_TAP_MS, HOLD_MS, type HassActionDetail } from '../src/actions';
import { ConfigError, SimplerCameraCard, normalizeConfig } from '../src/card';
import { EndpointError } from '../src/endpoint';
import type { StreamSupervisorDeps } from '../src/reliability/supervisor';
import { SnapshotLoop } from '../src/snapshot';
import {
  FakeImage,
  cameraEntity,
  collectHassActionDetails,
  fakeHass,
  installImageStub,
  pointer,
  releaseHassActions,
  tap,
} from './fixtures';
import { FakeMediaSource, FakeWebSocket, installObjectUrlStubs } from './player/stubs';
import {
  CARD_TAG,
  CARD_TYPE,
  HIDDEN_TEARDOWN_GRACE_MS,
  POSTER_REFRESH_INTERVAL_MS,
  TIER1_RETRY_DELAY_MS,
  type EndpointResolver,
  type HomeAssistant,
  type LivePlayer,
} from '../src/types';

const base = { type: CARD_TYPE, camera: 'camera.front_yard' };

/** The camera the wiring tests use: Frigate attributes plus a snapshot URL. */
const posterEntity = cameraEntity({
  entity_picture: '/api/camera_proxy/camera.front_yard?token=abc',
});

const WS_URL = 'wss://ha.local/api/frigate/abc/go2rtc/ws/api/ws?src=front_yard';

/** An {@link EndpointResolver} that resolves instantly, with no Home Assistant. */
function stubEndpoint(overrides: Partial<EndpointResolver> = {}): EndpointResolver {
  return {
    resolveSignedWsUrl: async () => WS_URL,
    resolvePosterUrl: async () => null,
    ...overrides,
  };
}

/** A resolver that never settles, parking the supervisor in `connecting`. */
function neverResolves(): EndpointResolver {
  return stubEndpoint({ resolveSignedWsUrl: () => new Promise<string>(() => {}) });
}

interface RecordingPlayer extends LivePlayer {
  video?: HTMLVideoElement;
  url?: string;
  destroyed: boolean;
}

/** Records every player the card's factory is asked to build. */
function recordingPlayerFactory(): { players: RecordingPlayer[]; create: () => RecordingPlayer } {
  const players: RecordingPlayer[] = [];
  const create = (): RecordingPlayer => {
    const player: RecordingPlayer = {
      destroyed: false,
      onPlaying: () => {},
      onDead: () => {},
      mount(video, url) {
        player.video = video;
        player.url = url;
      },
      destroy() {
        player.destroyed = true;
      },
    };
    players.push(player);
    return player;
  };
  return { players, create };
}

function mountCard(
  config: Record<string, unknown> = base,
  overrides: Partial<StreamSupervisorDeps> = {},
  hass: HomeAssistant = fakeHass(posterEntity),
): SimplerCameraCard {
  const card = document.createElement(CARD_TAG);
  card.supervisorOverrides = overrides;
  card.setConfig(config);
  card.hass = hass;
  document.body.appendChild(card);
  return card;
}

/** Flush Lit's update queue and the endpoint promise chain. */
async function settle(card: SimplerCameraCard): Promise<void> {
  for (let i = 0; i < 6; i += 1) await card.updateComplete;
}

function statusText(card: SimplerCameraCard): string | undefined {
  return card.shadowRoot?.querySelector('.status')?.textContent?.trim();
}

function container(card: SimplerCameraCard): HTMLElement {
  const element = card.shadowRoot?.querySelector<HTMLElement>('.container');
  if (!element) throw new Error('card has not rendered a .container');
  return element;
}

/** A snapshot resolver handing out a distinct signed URL per poll. */
function countingPoster(): { calls: () => number; resolvePosterUrl: () => Promise<string> } {
  let issued = 0;
  return {
    calls: () => issued,
    resolvePosterUrl: async () => `/api/camera_proxy/camera.front_yard?sig=${issued++}`,
  };
}

function snapshotSrc(card: SimplerCameraCard): string | undefined {
  return card.shadowRoot?.querySelector('img.snapshot')?.getAttribute('src') ?? undefined;
}

function posterSrc(card: SimplerCameraCard): string | undefined {
  return card.shadowRoot?.querySelector('img.poster')?.getAttribute('src') ?? undefined;
}

beforeEach(() => {
  // happy-dom implements no Media Source API at all, and the card's live
  // preflight (see `_startSupervisor`) refuses to start without one. Every test
  // below models an ordinary browser, so stand one in; the tests that model an
  // iPhone without MediaSource stub it away again for themselves.
  vi.stubGlobal('MediaSource', FakeMediaSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.querySelectorAll(CARD_TAG).forEach((card) => card.remove());
  releaseHassActions();
});

describe('normalizeConfig — required fields', () => {
  it('accepts a minimal config', () => {
    expect(normalizeConfig(base).camera).toBe('camera.front_yard');
  });

  it('rejects a non-object config', () => {
    expect(() => normalizeConfig(undefined)).toThrow(/YAML mapping/);
    expect(() => normalizeConfig([])).toThrow(/YAML mapping/);
  });

  it('rejects a missing camera', () => {
    expect(() => normalizeConfig({ type: CARD_TYPE })).toThrow(/"camera" is required/);
  });

  it('rejects a camera that is not an entity id', () => {
    expect(() => normalizeConfig({ ...base, camera: 'front_yard' })).toThrow(/entity id/);
  });

  it('rejects a non-camera entity', () => {
    expect(() => normalizeConfig({ ...base, camera: 'sensor.front_yard' })).toThrow(
      /must be a camera entity/,
    );
  });

  it('rejects an empty stream override', () => {
    expect(() => normalizeConfig({ ...base, stream: '  ' })).toThrow(/"stream"/);
  });
});

describe('normalizeConfig — defaults', () => {
  it('applies every documented default', () => {
    expect(normalizeConfig(base)).toEqual({
      type: CARD_TYPE,
      camera: 'camera.front_yard',
      overlay: 'none',
      tap_action: { action: 'none' },
      hold_action: { action: 'none' },
      double_tap_action: { action: 'none' },
      aspect_ratio: '16 / 9',
      reload_after_minutes_down: 0,
      mode: 'live',
      refresh_interval: 5,
      tap_to_live: false,
      live_duration: 60,
    });
  });

  it('preserves unknown keys that Lovelace injects', () => {
    const config = normalizeConfig({ ...base, grid_options: { columns: 6 } });
    expect(config.grid_options).toEqual({ columns: 6 });
  });
});

describe('normalizeConfig — enums', () => {
  it('rejects an unknown overlay mode', () => {
    expect(() => normalizeConfig({ ...base, overlay: 'label' })).toThrow(
      /"overlay" must be one of/,
    );
  });

  it('requires overlay_text when overlay is custom', () => {
    expect(() => normalizeConfig({ ...base, overlay: 'custom' })).toThrow(
      /requires "overlay_text"/,
    );
    expect(
      normalizeConfig({ ...base, overlay: 'custom', overlay_text: 'Drive' }).overlay_text,
    ).toBe('Drive');
  });

  it('rejects an unknown view mode', () => {
    expect(() => normalizeConfig({ ...base, mode: 'stills' })).toThrow(/"mode" must be one of/);
    expect(() => normalizeConfig({ ...base, mode: 1 })).toThrow(/"mode" must be one of/);
  });
});

describe('normalizeConfig — mode and refresh_interval', () => {
  it('defaults to live at a 5 second interval', () => {
    const config = normalizeConfig(base);
    expect(config.mode).toBe('live');
    expect(config.refresh_interval).toBe(5);
  });

  it('accepts snapshot mode with a fractional interval', () => {
    const config = normalizeConfig({ ...base, mode: 'snapshot', refresh_interval: 2.5 });
    expect(config.mode).toBe('snapshot');
    expect(config.refresh_interval).toBe(2.5);
  });

  it('accepts the 1 second minimum, and an explicit live mode', () => {
    expect(normalizeConfig({ ...base, refresh_interval: 1 }).refresh_interval).toBe(1);
    expect(normalizeConfig({ ...base, mode: 'live' }).mode).toBe('live');
  });

  it('rejects intervals below the 1 second minimum', () => {
    for (const interval of [0, 0.5, -4]) {
      expect(() => normalizeConfig({ ...base, refresh_interval: interval })).toThrow(
        /"refresh_interval" must be a number of seconds >= 1/,
      );
    }
  });

  it('rejects non-numeric and non-finite intervals', () => {
    for (const interval of ['4', true, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeConfig({ ...base, refresh_interval: interval })).toThrow(
        /"refresh_interval"/,
      );
    }
  });
});

describe('normalizeConfig — tap_to_live and live_duration', () => {
  it('defaults to disabled with a 60 second window', () => {
    const config = normalizeConfig(base);
    expect(config.tap_to_live).toBe(false);
    expect(config.live_duration).toBe(60);
  });

  it('accepts an explicit true and a fractional duration', () => {
    const config = normalizeConfig({ ...base, tap_to_live: true, live_duration: 7.5 });
    expect(config.tap_to_live).toBe(true);
    expect(config.live_duration).toBe(7.5);
  });

  it('accepts the 5 second minimum', () => {
    expect(normalizeConfig({ ...base, live_duration: 5 }).live_duration).toBe(5);
  });

  it('rejects a non-boolean tap_to_live', () => {
    for (const value of ['yes', 1]) {
      expect(() => normalizeConfig({ ...base, tap_to_live: value })).toThrow(
        /"tap_to_live" must be a boolean/,
      );
    }
  });

  it('rejects live_duration below the 5 second minimum', () => {
    for (const duration of [4.9, 0, -1]) {
      expect(() => normalizeConfig({ ...base, live_duration: duration })).toThrow(
        /"live_duration" must be a number of seconds >= 5/,
      );
    }
  });

  it('rejects non-numeric and non-finite live_duration', () => {
    for (const duration of ['60', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeConfig({ ...base, live_duration: duration })).toThrow(
        /"live_duration"/,
      );
    }
  });
});

describe('normalizeConfig — actions', () => {
  it('accepts HA-standard action objects', () => {
    const config = normalizeConfig({
      ...base,
      tap_action: { action: 'navigate', navigation_path: '/lovelace/cams' },
      hold_action: { action: 'more-info' },
      double_tap_action: { action: 'none' },
    });
    expect(config.tap_action).toEqual({ action: 'navigate', navigation_path: '/lovelace/cams' });
    expect(config.hold_action).toEqual({ action: 'more-info' });
  });

  it('accepts the legacy action names other cards use', () => {
    // `call-service` is the pre-rename `perform-action`; `fire-dom-event` is
    // browser_mod and friends. HA still handles both, and configs get copied
    // from stock cards wholesale.
    const config = normalizeConfig({
      ...base,
      tap_action: { action: 'call-service', service: 'light.toggle' },
      hold_action: { action: 'fire-dom-event', browser_mod: { service: 'popup' } },
    });
    expect(config.tap_action.action).toBe('call-service');
    expect(config.hold_action.action).toBe('fire-dom-event');
  });

  it('rejects an unknown action name', () => {
    expect(() => normalizeConfig({ ...base, tap_action: { action: 'explode' } })).toThrow(
      /"tap_action.action" must be one of/,
    );
  });

  it('rejects a non-object action', () => {
    expect(() => normalizeConfig({ ...base, hold_action: 'more-info' })).toThrow(
      /"hold_action" must be an action object/,
    );
  });
});

describe('normalizeConfig — aspect_ratio', () => {
  it('normalizes W:H strings to a CSS aspect-ratio', () => {
    expect(normalizeConfig({ ...base, aspect_ratio: '4:3' }).aspect_ratio).toBe('4 / 3');
    expect(normalizeConfig({ ...base, aspect_ratio: ' 16 / 9 ' }).aspect_ratio).toBe('16 / 9');
  });

  it('accepts a bare ratio', () => {
    expect(normalizeConfig({ ...base, aspect_ratio: 1.5 }).aspect_ratio).toBe('1.5');
    expect(normalizeConfig({ ...base, aspect_ratio: '1.5' }).aspect_ratio).toBe('1.5');
  });

  it('rejects nonsense', () => {
    expect(() => normalizeConfig({ ...base, aspect_ratio: 'wide' })).toThrow(/"aspect_ratio"/);
    expect(() => normalizeConfig({ ...base, aspect_ratio: 0 })).toThrow(/"aspect_ratio"/);
    expect(() => normalizeConfig({ ...base, aspect_ratio: '16:0' })).toThrow(/"aspect_ratio"/);
  });
});

describe('normalizeConfig — reload_after_minutes_down', () => {
  it('defaults to 0 (disabled) and accepts positive minutes', () => {
    expect(normalizeConfig(base).reload_after_minutes_down).toBe(0);
    expect(
      normalizeConfig({ ...base, reload_after_minutes_down: 15 }).reload_after_minutes_down,
    ).toBe(15);
  });

  it('rejects negative or non-numeric values', () => {
    expect(() => normalizeConfig({ ...base, reload_after_minutes_down: -1 })).toThrow(
      /reload_after_minutes_down/,
    );
    expect(() => normalizeConfig({ ...base, reload_after_minutes_down: '15' })).toThrow(
      /reload_after_minutes_down/,
    );
  });
});

/*
 * `normalizeConfig` rejects every config below — that is `setConfig` semantics
 * and it never changes. The `transient` flag is metadata *about* the rejection,
 * read only by the visual editor's `assertConfig` (see `editor.test.ts`): true
 * where the offending value is one a user types through in the form, false
 * where no form widget could have produced it.
 */
describe('normalizeConfig — transient vs structural errors', () => {
  /** Assert the config is rejected, and return the `ConfigError` it threw. */
  function rejection(raw: unknown): ConfigError {
    let thrown: unknown;
    expect(() => {
      try {
        normalizeConfig(raw);
      } catch (error) {
        thrown = error;
        throw error;
      }
    }, JSON.stringify(raw)).toThrow();
    expect(thrown, JSON.stringify(raw)).toBeInstanceOf(ConfigError);
    return thrown as ConfigError;
  }

  it('marks half-typed but form-representable values transient', () => {
    for (const raw of [
      { type: CARD_TYPE },
      { ...base, camera: '' },
      { ...base, camera: null },
      { ...base, refresh_interval: 0 },
      { ...base, refresh_interval: Number.NaN },
      { ...base, live_duration: 1 },
      { ...base, reload_after_minutes_down: -1 },
      { ...base, aspect_ratio: '16:' },
      { ...base, aspect_ratio: 'wide' },
      { ...base, aspect_ratio: 0 },
      { ...base, overlay: 'custom' },
      { ...base, overlay: 'custom', overlay_text: '' },
      { ...base, stream: '' },
      { ...base, stream: '  ' },
    ]) {
      expect(rejection(raw).transient, JSON.stringify(raw)).toBe(true);
    }
  });

  it('marks everything the form cannot produce structural', () => {
    for (const raw of [
      'not a mapping',
      [],
      { ...base, camera: 42 },
      { ...base, camera: 'front_yard' },
      { ...base, camera: 'sensor.front_yard' },
      { ...base, stream: 42 },
      { ...base, mode: 'stills' },
      { ...base, overlay: 'label' },
      { ...base, overlay_text: 7 },
      { ...base, refresh_interval: '4' },
      { ...base, live_duration: '60' },
      { ...base, reload_after_minutes_down: '15' },
      { ...base, tap_to_live: 'yes' },
      { ...base, aspect_ratio: true },
      { ...base, tap_action: 'more-info' },
      { ...base, hold_action: { action: 'explode' } },
    ]) {
      expect(rejection(raw).transient, JSON.stringify(raw)).toBe(false);
    }
  });

  it('defaults to structural', () => {
    expect(new ConfigError('boom').transient).toBe(false);
    expect(new ConfigError('boom').name).toBe('ConfigError');
  });
});

describe('SimplerCameraCard element', () => {
  it('is registered under the card tag', () => {
    expect(customElements.get(CARD_TAG)).toBe(SimplerCameraCard);
  });

  it('reports sizes for both view types', () => {
    const card = new SimplerCameraCard();
    expect(card.getCardSize()).toBeGreaterThan(0);
    // Home Assistant reads `getGridOptions` off the card *instance* — it is a
    // member of `LovelaceCard`, unlike `getStubConfig`/`getConfigForm`, which
    // are static on the constructor. A static one is simply never looked at.
    expect(card.getGridOptions()).toMatchObject({ columns: 12, min_columns: 6 });
    expect(SimplerCameraCard).not.toHaveProperty('getGridOptions');
  });

  it('setConfig propagates validation errors to Lovelace', () => {
    const card = new SimplerCameraCard();
    expect(() => card.setConfig({ type: CARD_TYPE })).toThrow(/"camera" is required/);
    expect(() => card.setConfig(base)).not.toThrow();
  });

  it('getStubConfig prefers a camera exposing camera_name', () => {
    const hass = fakeHass(
      // Not a Frigate camera: no camera_name to stream from.
      cameraEntity(
        { client_id: undefined, camera_name: undefined, friendly_name: 'Generic' },
        'camera.generic',
      ),
      cameraEntity({}, 'camera.frigate_one'),
    );
    expect(SimplerCameraCard.getStubConfig(hass)).toEqual({
      type: CARD_TYPE,
      camera: 'camera.frigate_one',
    });
  });

  it('getStubConfig falls back gracefully with no cameras at all', () => {
    expect(SimplerCameraCard.getStubConfig(fakeHass()).camera).toMatch(/^camera\./);
  });

  it('still accepts a pre-0.3.0 config carrying transport:', () => {
    // WebRTC was removed in 0.3.0. `transport:` is not migrated or warned
    // about — it degrades to one more unknown key, so dashboards written
    // against 0.2.x keep working untouched.
    const card = new SimplerCameraCard();
    expect(normalizeConfig({ ...base, transport: 'webrtc' }).transport).toBe('webrtc');
    expect(() => card.setConfig({ ...base, transport: 'webrtc' })).not.toThrow();
  });

  it('builds an MSE player', async () => {
    // The factory is internal, so it is observed through what the player
    // actually opens: a MediaSource, read off the global. That is what makes
    // this a test of the real wiring rather than of an injected double.
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('MediaSource', FakeMediaSource);
    const restoreObjectUrl = installObjectUrlStubs();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    FakeWebSocket.reset();
    FakeMediaSource.reset();

    try {
      const card = mountCard(base, { endpoint: stubEndpoint() });
      await settle(card);
      expect(FakeMediaSource.instances).toHaveLength(1);
      expect(FakeWebSocket.last().url).toBe(WS_URL);
      card.remove();
    } finally {
      info.mockRestore();
      restoreObjectUrl();
      vi.unstubAllGlobals();
    }
  });

  it('renders the shell: poster, video, overlay and status layers', async () => {
    const card = mountCard({ ...base, overlay: 'name' }, { endpoint: neverResolves() });
    await card.updateComplete;

    const root = card.shadowRoot!;
    expect(root.querySelector('video')).not.toBeNull();
    expect(root.querySelector('img.poster')?.getAttribute('src')).toContain('/api/camera_proxy/');
    expect(root.querySelector('.overlay')?.textContent?.trim()).toBe('Front Yard');
    expect(root.querySelector('.container')?.getAttribute('style')).toContain('16 / 9');

    // The supervisor starts as soon as config + hass + connection are present.
    await card.updateComplete;
    expect(root.querySelector('.status')?.textContent?.trim()).toBe('Connecting…');

    card.remove();
  });

  it('renders nothing before setConfig', async () => {
    const card = document.createElement(CARD_TAG);
    document.body.appendChild(card);
    await card.updateComplete;
    expect(card.shadowRoot!.querySelector('ha-card')).toBeNull();
    card.remove();
  });
});

describe('SimplerCameraCard — supervisor wiring', () => {
  it('mounts a player on the card’s own video element once everything is present', async () => {
    const { players, create } = recordingPlayerFactory();
    const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
    await settle(card);

    expect(players).toHaveLength(1);
    expect(players[0].url).toBe(WS_URL);
    expect(players[0].video).toBe(card.shadowRoot!.querySelector('video'));
  });

  it('waits for hass before starting, whatever order things arrive in', async () => {
    const { players, create } = recordingPlayerFactory();
    const card = document.createElement(CARD_TAG);
    card.supervisorOverrides = { createPlayer: create, endpoint: stubEndpoint() };
    card.setConfig(base);
    document.body.appendChild(card);
    await settle(card);
    expect(players).toHaveLength(0);

    card.hass = fakeHass(posterEntity);
    await settle(card);
    expect(players).toHaveLength(1);
  });

  it('stops the supervisor when the card leaves the DOM', async () => {
    const { players, create } = recordingPlayerFactory();
    const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
    await settle(card);

    card.remove();
    expect(players[0].destroyed).toBe(true);
  });

  it('rebuilds the supervisor when setConfig changes the stream', async () => {
    const { players, create } = recordingPlayerFactory();
    const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
    await settle(card);

    card.setConfig({ ...base, stream: 'front_yard_sub' });
    await settle(card);

    expect(players).toHaveLength(2);
    expect(players[0].destroyed).toBe(true);
    expect(players[1].destroyed).toBe(false);
  });

  it('keeps the same <video> element across re-renders', async () => {
    const card = mountCard({ ...base, overlay: 'name' }, { endpoint: neverResolves() });
    await settle(card);
    const video = card.shadowRoot!.querySelector('video');

    card.hass = fakeHass(cameraEntity());
    await settle(card);

    expect(card.shadowRoot!.querySelector('video')).toBe(video);
  });

  it('hides the poster and the status pill while playing', async () => {
    const { players, create } = recordingPlayerFactory();
    const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
    await settle(card);
    expect(card.shadowRoot!.querySelector('img.poster')).not.toBeNull();

    players[0].onPlaying();
    await settle(card);

    expect(card.shadowRoot!.querySelector('img.poster')).toBeNull();
    expect(statusText(card)).toBeUndefined();
  });

  it('surfaces an endpoint failure through the status indicator', async () => {
    const card = mountCard(base, {
      endpoint: stubEndpoint({
        resolveSignedWsUrl: async () => {
          throw new Error('Home Assistant refused to sign the path');
        },
      }),
    });
    await settle(card);
    expect(statusText(card)).toBe('Reconnecting in 2 s… — Home Assistant refused to sign the path');
  });
});

describe('SimplerCameraCard — lifecycle plumbing', () => {
  it('retries a dead stream on the tier-1 delay, showing the countdown', async () => {
    vi.useFakeTimers();
    const { players, create } = recordingPlayerFactory();
    const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
    await settle(card);

    players[0].onDead('ws-close');
    await settle(card);
    expect(statusText(card)).toBe('Reconnecting in 2 s…');

    await vi.advanceTimersByTimeAsync(TIER1_RETRY_DELAY_MS);
    await settle(card);
    expect(players).toHaveLength(2);
  });

  it('reconnects immediately on the hass.connected false→true edge', async () => {
    vi.useFakeTimers();
    const { players, create } = recordingPlayerFactory();
    const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
    await settle(card);

    players[0].onDead('ws-close');
    await settle(card);
    expect(players).toHaveLength(1);

    card.hass = { ...fakeHass(posterEntity), connected: false };
    card.hass = fakeHass(posterEntity);
    await settle(card);

    // No timer was advanced: the edge cut the pending backoff short.
    expect(players).toHaveLength(2);
  });

  it('tears the stream down after the hidden grace period and back up on visible', async () => {
    vi.useFakeTimers();
    const visibility = { value: 'visible' };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility.value,
    });
    try {
      const { players, create } = recordingPlayerFactory();
      const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
      await settle(card);

      visibility.value = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(HIDDEN_TEARDOWN_GRACE_MS);
      await settle(card);

      expect(players[0].destroyed).toBe(true);
      expect(statusText(card)).toBe('Paused while the dashboard is hidden.');

      visibility.value = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await settle(card);
      expect(players).toHaveLength(2);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it('treats pageshow/online/resume as page-resumed', async () => {
    vi.useFakeTimers();
    const { players, create } = recordingPlayerFactory();
    const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
    await settle(card);

    players[0].onDead('ws-close');
    await settle(card);
    expect(players).toHaveLength(1);

    window.dispatchEvent(new Event('online'));
    await settle(card);
    expect(players).toHaveLength(2);
  });

  it('never streams when the dashboard is already hidden at start', async () => {
    // The supervisor is built *after* the `visibilitychange` that hid the tab,
    // so nothing but the card can tell it what state the page is in.
    vi.useFakeTimers();
    const visibility = { value: 'hidden' };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility.value,
    });
    try {
      const { players, create } = recordingPlayerFactory();
      const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
      await settle(card);

      await vi.advanceTimersByTimeAsync(HIDDEN_TEARDOWN_GRACE_MS);
      await settle(card);
      expect(players[0].destroyed).toBe(true);
      expect(statusText(card)).toBe('Paused while the dashboard is hidden.');

      visibility.value = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await settle(card);
      expect(players).toHaveLength(2);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it('keeps the reload escape hatch on a permanent live card', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const reloadPage = vi.fn();
    const card = mountCard(
      { ...base, reload_after_minutes_down: 1 },
      { endpoint: neverResolves(), reloadPage },
    );
    await settle(card);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('recovers from a rejected update instead of latching the start guard', async () => {
    const { players, create } = recordingPlayerFactory();
    const card = document.createElement(CARD_TAG);
    card.supervisorOverrides = { createPlayer: create, endpoint: stubEndpoint() };
    card.setConfig(base);
    document.body.appendChild(card);
    await settle(card);
    expect(players).toHaveLength(0);

    // One update cycle rejects while a start is pending — anything throwing
    // inside a render does this. The test owns the only other handle on the
    // rejection, so an unfixed card cannot poison the run.
    const rejected = Promise.reject(new Error('render blew up'));
    rejected.catch(() => {});
    Object.defineProperty(card, 'updateComplete', { configurable: true, get: () => rejected });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    card.hass = fakeHass(posterEntity);
    await rejected.catch(() => {});
    await Promise.resolve();
    delete (card as unknown as Record<string, unknown>).updateComplete;
    info.mockRestore();

    // That start was abandoned, as it must be — but the card is not dead.
    expect(players).toHaveLength(0);
    card.hass = fakeHass(posterEntity);
    await settle(card);
    expect(players).toHaveLength(1);
  });

  it('drops its listeners when disconnected', async () => {
    vi.useFakeTimers();
    const { players, create } = recordingPlayerFactory();
    const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
    await settle(card);
    card.remove();

    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(HIDDEN_TEARDOWN_GRACE_MS + TIER1_RETRY_DELAY_MS);

    expect(players).toHaveLength(1);
  });
});

describe('SimplerCameraCard — actions', () => {
  it('fires hass-action from the host with the camera entity and every slot', async () => {
    const fired = collectHassActionDetails();
    const card = mountCard(
      {
        ...base,
        tap_action: { action: 'more-info' },
        hold_action: { action: 'navigate', navigation_path: '/lovelace/cams' },
      },
      { endpoint: neverResolves() },
    );
    await settle(card);

    tap(container(card));

    expect(fired).toEqual([
      {
        action: 'tap',
        config: {
          entity: 'camera.front_yard',
          tap_action: { action: 'more-info' },
          hold_action: { action: 'navigate', navigation_path: '/lovelace/cams' },
          double_tap_action: { action: 'none' },
        },
      },
    ]);
  });

  it('lets the event out of the shadow root by way of the host element', async () => {
    const card = mountCard(
      { ...base, tap_action: { action: 'more-info' } },
      { endpoint: neverResolves() },
    );
    await settle(card);

    const targets: EventTarget[] = [];
    document.addEventListener('hass-action', (event) => targets.push(event.target!), {
      once: true,
    });
    tap(container(card));

    expect(targets).toEqual([card]);
  });

  it('recognises hold and double-tap once they are configured', async () => {
    vi.useFakeTimers();
    const fired = collectHassActionDetails();
    const card = mountCard(
      {
        ...base,
        hold_action: { action: 'toggle' },
        double_tap_action: { action: 'url', url_path: '/wall' },
      },
      { endpoint: neverResolves() },
    );
    await settle(card);
    const surface = container(card);

    surface.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(HOLD_MS);
    surface.dispatchEvent(pointer('pointerup'));

    tap(surface);
    tap(surface);
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 2);

    expect(fired.map((detail) => detail.action)).toEqual(['hold', 'double_tap']);
  });

  it('picks up a config edit without being re-wired', async () => {
    const fired = collectHassActionDetails();
    const card = mountCard(base, { endpoint: neverResolves() });
    await settle(card);

    card.setConfig({ ...base, tap_action: { action: 'toggle' } });
    await settle(card);
    tap(container(card));

    expect(fired[0].config.tap_action).toEqual({ action: 'toggle' });
  });

  it('exposes button semantics only while the tap action does something', async () => {
    const card = mountCard(
      { ...base, tap_action: { action: 'more-info' } },
      { endpoint: neverResolves() },
    );
    await settle(card);

    let surface = container(card);
    expect(surface.getAttribute('role')).toBe('button');
    expect(surface.getAttribute('tabindex')).toBe('0');
    expect(surface.getAttribute('aria-label')).toBe('Front Yard');
    expect(surface.className).toContain('interactive');

    card.setConfig({ ...base, tap_action: { action: 'none' } });
    await settle(card);

    surface = container(card);
    expect(surface.hasAttribute('role')).toBe(false);
    expect(surface.hasAttribute('tabindex')).toBe(false);
    expect(surface.hasAttribute('aria-label')).toBe(false);
    expect(surface.className).not.toContain('interactive');
  });

  it('activates from the keyboard', async () => {
    const fired = collectHassActionDetails();
    const card = mountCard(
      { ...base, tap_action: { action: 'more-info' } },
      { endpoint: neverResolves() },
    );
    await settle(card);

    container(card).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(fired.map((detail) => detail.action)).toEqual(['tap']);
  });

  it('stays deaf when a render lands after the card left the DOM', async () => {
    const card = mountCard(
      { ...base, tap_action: { action: 'more-info' } },
      { endpoint: neverResolves() },
    );
    await settle(card);
    const surface = container(card);
    // The host is what `hass-action` is dispatched from, so listening there
    // still hears the event once the card is detached from the document.
    const fired: string[] = [];
    card.addEventListener('hass-action', (event) => {
      fired.push((event as CustomEvent<HassActionDetail>).detail.action);
    });

    // Teardown mutates reactive state (`_streamState` → `idle`), so a Lit
    // update always lands *after* `disconnectedCallback` has detached — and
    // an update that re-attaches leaves listeners nothing will ever remove.
    card.remove();
    await settle(card);
    tap(surface);

    expect(fired).toEqual([]);
  });

  it('stops listening once the card leaves the DOM, and listens again on return', async () => {
    const fired = collectHassActionDetails();
    const card = mountCard(
      { ...base, tap_action: { action: 'more-info' } },
      { endpoint: neverResolves() },
    );
    await settle(card);
    const surface = container(card);

    card.remove();
    tap(surface);
    expect(fired).toEqual([]);

    document.body.appendChild(card);
    await settle(card);
    tap(container(card));
    expect(fired.map((detail) => detail.action)).toEqual(['tap']);
  });
});

describe('SimplerCameraCard — poster', () => {
  it('refreshes the signed snapshot while down, and stops once playing', async () => {
    vi.useFakeTimers();
    let issued = 0;
    const { players, create } = recordingPlayerFactory();
    const card = mountCard(base, {
      createPlayer: create,
      endpoint: stubEndpoint({
        resolvePosterUrl: async () => `/api/camera_proxy/camera.front_yard?sig=${issued++}`,
      }),
    });
    await settle(card);

    expect(card.shadowRoot!.querySelector('img.poster')?.getAttribute('src')).toContain('sig=0');

    await vi.advanceTimersByTimeAsync(POSTER_REFRESH_INTERVAL_MS);
    await settle(card);
    expect(card.shadowRoot!.querySelector('img.poster')?.getAttribute('src')).toContain('sig=1');

    players[0].onPlaying();
    await settle(card);
    await vi.advanceTimersByTimeAsync(POSTER_REFRESH_INTERVAL_MS * 3);
    expect(issued).toBe(2);
  });

  it('drops a signed URL that lands after the poster was retired', async () => {
    // Signing waits on a websocket round-trip, so a refresh started while the
    // stream was down can settle long after the reason for it is gone. Writing
    // it then resurrects a poster nobody asked for — and after a `setConfig`
    // it would be a poster of a *different* camera.
    const { players, create } = recordingPlayerFactory();
    let releasePoster: ((url: string) => void) | undefined;
    const card = mountCard(base, {
      createPlayer: create,
      endpoint: stubEndpoint({
        resolvePosterUrl: () =>
          new Promise<string>((resolve) => {
            releasePoster = resolve;
          }),
      }),
    });
    await settle(card);
    // Connecting: a refresh is in flight and the unsigned fallback is showing.
    expect(posterSrc(card)).toContain('token=abc');

    players[0].onPlaying();
    await settle(card);
    expect(posterSrc(card)).toBeUndefined();

    // The signature arrives after the stream came up.
    releasePoster!('/api/camera_proxy/camera.front_yard?sig=stale');
    await settle(card);

    // Down again, so the poster layer is back: it must not be that URL.
    players[0].onDead('ws-close');
    await settle(card);
    expect(posterSrc(card)).not.toContain('sig=stale');
    expect(posterSrc(card)).toContain('token=abc');
  });

  it('never lets a poster failure take the card down (live mode)', async () => {
    const { players, create } = recordingPlayerFactory();
    const card = mountCard(base, {
      createPlayer: create,
      endpoint: stubEndpoint({
        resolvePosterUrl: async () => {
          throw new Error('sign-failed');
        },
      }),
    });
    await settle(card);

    // The stream is unaffected, and the unsigned entity_picture still shows.
    expect(players).toHaveLength(1);
    expect(card.shadowRoot!.querySelector('img.poster')?.getAttribute('src')).toContain(
      'token=abc',
    );
  });

  // A hostile integration could plant an off-origin `entity_picture` as a
  // per-view tracking beacon; the raw attribute fallback must stay
  // same-origin (unlike `_posterUrl`/`_snapshotUrl`, which are signed
  // absolute URLs produced by our own resolver and are not filtered).
  it('drops an off-origin entity_picture instead of rendering it as a poster', async () => {
    // `//` and `/\` are protocol-relative (browsers fold `\` into `/`).
    for (const picture of [
      'https://evil.example/beacon.png',
      '//evil.example/beacon.png',
      '/\\evil.example/beacon.png',
    ]) {
      const offOriginEntity = cameraEntity({ entity_picture: picture });
      const { create } = recordingPlayerFactory();
      const card = mountCard(
        base,
        { createPlayer: create, endpoint: neverResolves() },
        fakeHass(offOriginEntity),
      );
      await settle(card);

      expect(card.shadowRoot!.querySelector('img.poster'), picture).toBeNull();
      card.remove();
    }
  });

  it('still renders a relative entity_picture as before', async () => {
    const { create } = recordingPlayerFactory();
    const card = mountCard(
      base,
      { createPlayer: create, endpoint: neverResolves() },
      fakeHass(posterEntity),
    );
    await settle(card);

    expect(card.shadowRoot!.querySelector('img.poster')?.getAttribute('src')).toContain(
      '/api/camera_proxy/camera.front_yard?token=abc',
    );
  });
});

describe('SimplerCameraCard — snapshot mode', () => {
  const snapshotBase = { ...base, mode: 'snapshot', refresh_interval: 2 };

  it('polls stills and never builds a stream', async () => {
    vi.useFakeTimers();
    installImageStub();
    const poster = countingPoster();
    const { players, create } = recordingPlayerFactory();
    const started = vi.spyOn(SnapshotLoop.prototype, 'start');

    const card = mountCard(snapshotBase, {
      createPlayer: create,
      endpoint: stubEndpoint({ resolvePosterUrl: poster.resolvePosterUrl }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);

    // No supervisor, no player, no <video> — just a refreshing <img>.
    expect(started).toHaveBeenCalledTimes(1);
    expect(players).toHaveLength(0);
    expect(card.shadowRoot!.querySelector('video')).toBeNull();
    expect(snapshotSrc(card)).toContain('sig=0');
    expect(statusText(card)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(2_000);
    await settle(card);
    expect(snapshotSrc(card)).toContain('sig=1');
    expect(poster.calls()).toBe(2);
  });

  it('shows the unsigned entity_picture and a connecting pill until the first frame', async () => {
    installImageStub();
    const card = mountCard(snapshotBase, {
      endpoint: stubEndpoint({ resolvePosterUrl: () => new Promise<string>(() => {}) }),
    });
    await settle(card);

    expect(snapshotSrc(card)).toBeUndefined();
    expect(card.shadowRoot!.querySelector('img.poster')?.getAttribute('src')).toContain(
      'token=abc',
    );
    expect(statusText(card)).toBe('Connecting…');
  });

  it('live mode (and the default) never builds a snapshot loop', async () => {
    installImageStub();
    const started = vi.spyOn(SnapshotLoop.prototype, 'start');
    const { players, create } = recordingPlayerFactory();

    const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
    await settle(card);
    expect(started).not.toHaveBeenCalled();
    expect(players).toHaveLength(1);

    const explicit = mountCard(
      { ...base, mode: 'live', refresh_interval: 1 },
      {
        createPlayer: create,
        endpoint: stubEndpoint(),
      },
    );
    await settle(explicit);
    expect(started).not.toHaveBeenCalled();
    expect(explicit.shadowRoot!.querySelector('img.snapshot')).toBeNull();
  });

  it('reports a stale feed after three failed polls, and clears it on recovery', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    installImageStub('error');
    const poster = countingPoster();

    const card = mountCard(snapshotBase, {
      endpoint: stubEndpoint({ resolvePosterUrl: poster.resolvePosterUrl }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);
    expect(statusText(card)).toBe('Connecting…');

    await vi.advanceTimersByTimeAsync(4_000);
    await settle(card);
    expect(statusText(card)).toBe('Snapshot is stale…');

    FakeImage.behaviour = 'load';
    await vi.advanceTimersByTimeAsync(2_000);
    await settle(card);
    expect(statusText(card)).toBeUndefined();
    expect(snapshotSrc(card)).toContain('sig=3');
  });

  it('surfaces a config-class endpoint error the way live mode does', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    installImageStub();

    const card = mountCard(snapshotBase, {
      endpoint: stubEndpoint({
        resolvePosterUrl: () =>
          Promise.reject(new EndpointError('entity-not-found', 'Camera entity was not found.')),
      }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);

    expect(statusText(card)).toBe('Snapshot unavailable — Camera entity was not found.');
  });

  it('pauses polling while hidden and refreshes when visible again', async () => {
    vi.useFakeTimers();
    installImageStub();
    const poster = countingPoster();
    const visibility = { value: 'visible' };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility.value,
    });
    try {
      const card = mountCard(snapshotBase, {
        endpoint: stubEndpoint({ resolvePosterUrl: poster.resolvePosterUrl }),
      });
      await vi.advanceTimersByTimeAsync(0);
      await settle(card);
      expect(poster.calls()).toBe(1);

      visibility.value = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(poster.calls()).toBe(1);

      visibility.value = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      await settle(card);
      expect(poster.calls()).toBe(2);
      expect(snapshotSrc(card)).toContain('sig=1');
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it('stays paused when online/pageshow fire under a hidden dashboard', async () => {
    vi.useFakeTimers();
    installImageStub();
    const poster = countingPoster();
    const visibility = { value: 'visible' };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility.value,
    });
    try {
      const card = mountCard(snapshotBase, {
        endpoint: stubEndpoint({ resolvePosterUrl: poster.resolvePosterUrl }),
      });
      await vi.advanceTimersByTimeAsync(0);
      await settle(card);
      expect(poster.calls()).toBe(1);

      visibility.value = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);

      // Wi-Fi flaps under a tab nobody is looking at: neither event may
      // un-pause the loop for the rest of the hidden period.
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('pageshow'));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(poster.calls()).toBe(1);

      visibility.value = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      await settle(card);
      expect(poster.calls()).toBe(2);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it('refreshes at once on pageshow and on the hass.connected edge', async () => {
    vi.useFakeTimers();
    installImageStub();
    const poster = countingPoster();
    const card = mountCard(snapshotBase, {
      endpoint: stubEndpoint({ resolvePosterUrl: poster.resolvePosterUrl }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);
    expect(poster.calls()).toBe(1);

    window.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(0);
    expect(poster.calls()).toBe(2);

    card.hass = { ...fakeHass(posterEntity), connected: false };
    card.hass = fakeHass(posterEntity);
    await vi.advanceTimersByTimeAsync(0);
    expect(poster.calls()).toBe(3);
  });

  it('destroys the loop when the card leaves the DOM, and rebuilds it on setConfig', async () => {
    vi.useFakeTimers();
    installImageStub();
    const destroyed = vi.spyOn(SnapshotLoop.prototype, 'destroy');
    const poster = countingPoster();
    const card = mountCard(snapshotBase, {
      endpoint: stubEndpoint({ resolvePosterUrl: poster.resolvePosterUrl }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);

    card.setConfig({ ...snapshotBase, refresh_interval: 5 });
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);
    expect(destroyed).toHaveBeenCalledTimes(1);

    const pollsWhileMounted = poster.calls();
    card.remove();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(destroyed).toHaveBeenCalledTimes(2);
    expect(poster.calls()).toBe(pollsWhileMounted);
  });

  it('keeps the overlay and the tap action working', async () => {
    vi.useFakeTimers();
    installImageStub();
    const fired = collectHassActionDetails();
    const card = mountCard(
      { ...snapshotBase, overlay: 'name', tap_action: { action: 'more-info' } },
      { endpoint: stubEndpoint({ resolvePosterUrl: countingPoster().resolvePosterUrl }) },
    );
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);

    expect(card.shadowRoot!.querySelector('.overlay')?.textContent?.trim()).toBe('Front Yard');
    expect(container(card).getAttribute('style')).toContain('16 / 9');

    tap(container(card));
    expect(fired.map((detail) => detail.action)).toEqual(['tap']);
  });
});

describe('SimplerCameraCard — tap to go live', () => {
  /** A snapshot card that goes live for 10 s on a tap. */
  const tapLiveBase = {
    ...base,
    mode: 'snapshot',
    refresh_interval: 2,
    tap_to_live: true,
    live_duration: 10,
  };

  interface LiveRig {
    card: SimplerCameraCard;
    players: RecordingPlayer[];
    poster: ReturnType<typeof countingPoster>;
    fired: HassActionDetail[];
    starts: () => number;
    destroys: () => number;
  }

  /**
   * Mount a card with fake timers, a stubbed `Image`, a counting poster
   * resolver and a recording player factory, then let the first snapshot land.
   */
  async function rig(
    config: Record<string, unknown> = tapLiveBase,
    endpointOverrides: Partial<EndpointResolver> = {},
  ): Promise<LiveRig> {
    vi.useFakeTimers();
    installImageStub();
    const fired = collectHassActionDetails();
    const poster = countingPoster();
    const { players, create } = recordingPlayerFactory();
    const started = vi.spyOn(SnapshotLoop.prototype, 'start');
    const destroyed = vi.spyOn(SnapshotLoop.prototype, 'destroy');
    const card = mountCard(config, {
      createPlayer: create,
      endpoint: stubEndpoint({ resolvePosterUrl: poster.resolvePosterUrl, ...endpointOverrides }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);
    return {
      card,
      players,
      poster,
      fired,
      starts: () => started.mock.calls.length,
      destroys: () => destroyed.mock.calls.length,
    };
  }

  /** A tap, plus everything the resulting engine swap needs to settle. */
  async function tapAndSettle(card: SimplerCameraCard): Promise<void> {
    tap(container(card));
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);
  }

  it('swaps the snapshot loop for the live stack on a tap, firing no tap_action', async () => {
    const { card, players, fired, destroys } = await rig();
    expect(players).toHaveLength(0);
    expect(snapshotSrc(card)).toContain('sig=0');

    await tapAndSettle(card);

    expect(destroys()).toBe(1);
    expect(players).toHaveLength(1);
    expect(players[0].video).toBe(card.shadowRoot!.querySelector('video'));
    // The tap was consumed by the toggle: Home Assistant hears nothing.
    expect(fired).toEqual([]);
  });

  it('reverts on a second tap, with an immediate fresh poll', async () => {
    const { card, players, poster, starts, destroys } = await rig();
    await tapAndSettle(card);
    const pollsBefore = poster.calls();

    await tapAndSettle(card);

    expect(players[0].destroyed).toBe(true);
    expect(starts()).toBe(2);
    expect(destroys()).toBe(1);
    expect(card.shadowRoot!.querySelector('video')).toBeNull();
    // The new loop polls at once rather than waiting out an interval.
    expect(poster.calls()).toBeGreaterThan(pollsBefore);
    expect(snapshotSrc(card)).toBeDefined();
  });

  it('reverts when the window expires, honouring a fractional duration', async () => {
    const { card, players, starts } = await rig({ ...tapLiveBase, live_duration: 7.5 });
    await tapAndSettle(card);
    expect(players).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(7_000);
    await settle(card);
    expect(players[0].destroyed).toBe(false);
    expect(starts()).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    await settle(card);

    expect(players[0].destroyed).toBe(true);
    expect(starts()).toBe(2);
    expect(card.shadowRoot!.querySelector('video')).toBeNull();
  });

  it('reverts when the dashboard is hidden, and comes back as a snapshot card', async () => {
    const visibility = { value: 'visible' };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility.value,
    });
    try {
      const { card, players, poster } = await rig();
      await tapAndSettle(card);
      const pollsWhileLive = poster.calls();

      visibility.value = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      await settle(card);

      expect(players[0].destroyed).toBe(true);
      expect(poster.calls()).toBeGreaterThan(pollsWhileLive);

      // The restarted loop is paused: neither it nor the poster refresh spends
      // a request while the dashboard is hidden.
      const pollsWhileHidden = poster.calls();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(poster.calls()).toBe(pollsWhileHidden);

      visibility.value = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      await settle(card);

      // Snapshots resume; the live window does not.
      expect(poster.calls()).toBeGreaterThan(pollsWhileHidden);
      expect(players).toHaveLength(1);
      expect(card.shadowRoot!.querySelector('video')).toBeNull();
      expect(snapshotSrc(card)).toBeDefined();
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it('keeps the last still on screen while the stream connects', async () => {
    // A window long enough that the poster refresh below stays inside it.
    const { card } = await rig(
      { ...tapLiveBase, live_duration: 30 },
      { resolveSignedWsUrl: () => new Promise<string>(() => {}) },
    );
    expect(snapshotSrc(card)).toContain('sig=0');

    tap(container(card));
    await card.updateComplete;

    // The <img class="snapshot"> is gone (live mode owns the media layer), so
    // the poster is all that stands between the user and a black rectangle.
    expect(snapshotSrc(card)).toBeUndefined();
    expect(posterSrc(card)).toContain('sig=0');

    // …and it never blanks while the connect drags on.
    await settle(card);
    expect(posterSrc(card)).toBeDefined();
    await vi.advanceTimersByTimeAsync(POSTER_REFRESH_INTERVAL_MS);
    await settle(card);
    expect(posterSrc(card)).toBeDefined();
  });

  it('shows a counting-down LIVE pill, but only once the stream plays', async () => {
    const { card, players } = await rig({ ...tapLiveBase, live_duration: 8 });
    await tapAndSettle(card);
    // Connecting is still reported the way live mode always reports it.
    expect(statusText(card)).toBe('Connecting…');

    players[0].onPlaying();
    await settle(card);
    expect(statusText(card)).toBe('LIVE · 8s');

    await vi.advanceTimersByTimeAsync(1_000);
    await settle(card);
    expect(statusText(card)).toBe('LIVE · 7s');

    await vi.advanceTimersByTimeAsync(3_000);
    await settle(card);
    expect(statusText(card)).toBe('LIVE · 4s');

    // The window ends: the pill goes with it.
    await vi.advanceTimersByTimeAsync(4_000);
    await settle(card);
    expect(statusText(card)).toBeUndefined();
    expect(players[0].destroyed).toBe(true);
  });

  it('suppresses the snapshot status text for the whole window', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { card } = await rig(tapLiveBase, {
      resolveSignedWsUrl: () => new Promise<string>(() => {}),
      resolvePosterUrl: async () => {
        throw new EndpointError('entity-not-found', 'Camera entity was not found.');
      },
    });
    expect(statusText(card)).toBe('Snapshot unavailable — Camera entity was not found.');

    await tapAndSettle(card);
    expect(statusText(card)).toBe('Connecting…');

    await vi.advanceTimersByTimeAsync(6_000);
    await settle(card);
    expect(statusText(card)).toBe('Connecting…');
  });

  it('toggles even when tap_action is none, and announces which way the tap goes', async () => {
    const { card, players, fired } = await rig({
      ...tapLiveBase,
      tap_action: { action: 'none' },
    });

    let surface = container(card);
    expect(surface.getAttribute('role')).toBe('button');
    expect(surface.getAttribute('tabindex')).toBe('0');
    expect(surface.getAttribute('aria-label')).toBe('Front Yard — go live');

    await tapAndSettle(card);

    expect(players).toHaveLength(1);
    expect(fired).toEqual([]);
    surface = container(card);
    expect(surface.getAttribute('aria-label')).toBe('Front Yard — back to snapshots');
  });

  it('leaves tap_action alone without tap_to_live, and under mode: live', async () => {
    const plain = await rig({
      ...tapLiveBase,
      tap_to_live: false,
      tap_action: { action: 'more-info' },
    });
    await tapAndSettle(plain.card);
    expect(plain.fired.map((detail) => detail.action)).toEqual(['tap']);
    expect(plain.players).toHaveLength(0);
    expect(plain.card.shadowRoot!.querySelector('video')).toBeNull();

    // Under `mode: live` both options are ignored, exactly like refresh_interval.
    const live = await rig({
      ...base,
      mode: 'live',
      tap_to_live: true,
      live_duration: 8,
      tap_action: { action: 'more-info' },
    });
    await tapAndSettle(live.card);
    expect(live.fired.map((detail) => detail.action)).toEqual(['tap']);
    expect(container(live.card).getAttribute('aria-label')).toBe('Front Yard');
    // One player from the ordinary live start, none from a toggle.
    expect(live.players).toHaveLength(1);
  });

  it('leaves hold and double-tap untouched on an eligible card', async () => {
    const { card, players, fired } = await rig({
      ...tapLiveBase,
      hold_action: { action: 'toggle' },
      double_tap_action: { action: 'url', url_path: '/wall' },
    });
    const surface = container(card);

    surface.dispatchEvent(pointer('pointerdown'));
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    surface.dispatchEvent(pointer('pointerup'));

    tap(surface);
    tap(surface);
    await vi.advanceTimersByTimeAsync(DOUBLE_TAP_MS * 2);
    await settle(card);

    expect(fired.map((detail) => detail.action)).toEqual(['hold', 'double_tap']);
    // Neither gesture went live.
    expect(players).toHaveLength(0);
  });

  it('never arms the reload escape hatch inside the window', async () => {
    // A tap must not be able to reload a whole dashboard. `live_duration` has
    // no upper bound in YAML (the 60 s slider cap belongs to the editor), so a
    // window can easily outlive `reload_after_minutes_down`.
    vi.useFakeTimers();
    installImageStub();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const reloadPage = vi.fn();
    const card = mountCard(
      { ...tapLiveBase, live_duration: 120, reload_after_minutes_down: 1 },
      {
        createPlayer: recordingPlayerFactory().create,
        endpoint: stubEndpoint({
          resolvePosterUrl: countingPoster().resolvePosterUrl,
          // The stream is dead: the supervisor never leaves `connecting`, so
          // the escape hatch's deadline is reached with nothing to stop it.
          resolveSignedWsUrl: () => new Promise<string>(() => {}),
        }),
        reloadPage,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);

    await tapAndSettle(card);
    expect(card.shadowRoot!.querySelector('video')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(61_000);
    await settle(card);
    expect(reloadPage).not.toHaveBeenCalled();
    // …and the window is still the thing in charge of ending itself.
    expect(card.shadowRoot!.querySelector('video')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);
    await settle(card);
    expect(reloadPage).not.toHaveBeenCalled();
    expect(card.shadowRoot!.querySelector('video')).toBeNull();
  });

  it('tears the window down on setConfig, timers and all', async () => {
    const { card, players, poster, starts } = await rig();
    await tapAndSettle(card);

    card.setConfig({ ...tapLiveBase, refresh_interval: 3 });
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);

    expect(players[0].destroyed).toBe(true);
    expect(starts()).toBe(2);

    // The window timer is gone: its expiry cannot fire a second revert, and the
    // countdown cannot resurrect the pill.
    const pollsAfterEdit = poster.calls();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle(card);
    expect(players).toHaveLength(1);
    expect(starts()).toBe(2);
    expect(statusText(card)).toBeUndefined();
    expect(poster.calls()).toBeGreaterThan(pollsAfterEdit);
  });

  it('tears the window down when the card leaves the DOM, with no callbacks after', async () => {
    const { card, players, poster, starts } = await rig();
    await tapAndSettle(card);

    card.remove();
    const pollsWhileMounted = poster.calls();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(players[0].destroyed).toBe(true);
    expect(players).toHaveLength(1);
    expect(starts()).toBe(1);
    expect(poster.calls()).toBe(pollsWhileMounted);
  });
});

describe('SimplerCameraCard — live capability preflight', () => {
  const NO_MSE = 'Live view needs MediaSource (iOS 17.1+). Use mode: snapshot.';

  /** An iPhone below 17.1 — or anything else with no Media Source API at all. */
  function withoutMediaSource(): void {
    vi.stubGlobal('MediaSource', undefined);
    vi.stubGlobal('ManagedMediaSource', undefined);
  }

  /** A signed-URL resolver that counts the times the supervisor asked for one. */
  function countingSignedUrl(): { calls: () => number; resolveSignedWsUrl: () => Promise<string> } {
    let issued = 0;
    return {
      calls: () => issued,
      resolveSignedWsUrl: async () => {
        issued += 1;
        return WS_URL;
      },
    };
  }

  it('says so permanently instead of retrying, on a mode: live card', async () => {
    withoutMediaSource();
    vi.useFakeTimers();
    const signed = countingSignedUrl();
    const { players, create } = recordingPlayerFactory();

    const card = mountCard(base, {
      createPlayer: create,
      endpoint: stubEndpoint({ resolveSignedWsUrl: signed.resolveSignedWsUrl }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);

    expect(statusText(card)).toBe(NO_MSE);
    // Nothing was built and nothing was signed: no supervisor, so no socket.
    expect(players).toHaveLength(0);
    expect(signed.calls()).toBe(0);

    // And no retry ladder is running behind the message.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await settle(card);
    expect(statusText(card)).toBe(NO_MSE);
    expect(players).toHaveLength(0);
    expect(signed.calls()).toBe(0);
  });

  it('leaves snapshot mode entirely alone in the same browser', async () => {
    withoutMediaSource();
    vi.useFakeTimers();
    installImageStub();
    const poster = countingPoster();
    const { players, create } = recordingPlayerFactory();

    const card = mountCard(
      { ...base, mode: 'snapshot', refresh_interval: 2 },
      {
        createPlayer: create,
        endpoint: stubEndpoint({ resolvePosterUrl: poster.resolvePosterUrl }),
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);

    expect(snapshotSrc(card)).toContain('sig=0');
    expect(statusText(card)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(2_000);
    await settle(card);
    expect(snapshotSrc(card)).toContain('sig=1');
    expect(players).toHaveLength(0);
  });

  it('shows the message for a tap_to_live window, then reverts on schedule', async () => {
    withoutMediaSource();
    vi.useFakeTimers();
    installImageStub();
    const poster = countingPoster();
    const { players, create } = recordingPlayerFactory();

    const card = mountCard(
      { ...base, mode: 'snapshot', refresh_interval: 2, tap_to_live: true, live_duration: 10 },
      {
        createPlayer: create,
        endpoint: stubEndpoint({ resolvePosterUrl: poster.resolvePosterUrl }),
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);

    tap(container(card));
    await vi.advanceTimersByTimeAsync(0);
    await settle(card);

    // The window runs — the card is in live mode — but says why it cannot play.
    expect(card.shadowRoot!.querySelector('video')).not.toBeNull();
    expect(statusText(card)).toBe(NO_MSE);
    expect(players).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    await settle(card);

    expect(card.shadowRoot!.querySelector('video')).toBeNull();
    expect(statusText(card)).toBeUndefined();
    expect(snapshotSrc(card)).toBeDefined();
  });
});
