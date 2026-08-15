import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOUBLE_TAP_MS, HOLD_MS, type HassActionDetail } from '../src/actions';
import { SimplerCameraCard, normalizeConfig } from '../src/card';
import type { StreamSupervisorDeps } from '../src/reliability/supervisor';
import {
  FakeMediaSource,
  FakePeerConnection,
  FakeWebSocket,
  installObjectUrlStubs,
} from './player/stubs';
import {
  CARD_TAG,
  CARD_TYPE,
  HIDDEN_TEARDOWN_GRACE_MS,
  POSTER_REFRESH_INTERVAL_MS,
  TIER1_RETRY_DELAY_MS,
  type CameraEntity,
  type EndpointResolver,
  type HomeAssistant,
  type LivePlayer,
} from '../src/types';

const base = { type: CARD_TYPE, camera: 'camera.front_yard' };

function cameraEntity(
  entity_id = 'camera.front_yard',
  attributes: CameraEntity['attributes'] = {
    camera_name: 'front_yard',
    friendly_name: 'Front Yard',
  },
): CameraEntity {
  return { entity_id, state: 'streaming', attributes };
}

function fakeHass(...entities: CameraEntity[]): HomeAssistant {
  return {
    states: Object.fromEntries(entities.map((e) => [e.entity_id, e])),
    connected: true,
    connection: {} as HomeAssistant['connection'],
    callWS: async () => ({}) as never,
  };
}

/** The camera the wiring tests use: Frigate attributes plus a snapshot URL. */
const posterEntity = cameraEntity('camera.front_yard', {
  camera_name: 'front_yard',
  friendly_name: 'Front Yard',
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

interface FakePlayer extends LivePlayer {
  video?: HTMLVideoElement;
  url?: string;
  destroyed: boolean;
}

/** Records every player the card's factory is asked to build. */
function playerFactory(): { players: FakePlayer[]; create: () => FakePlayer } {
  const players: FakePlayer[] = [];
  const create = (): FakePlayer => {
    const player: FakePlayer = {
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

/** Every `hass-action` the card lets escape, cleaned up after each test. */
function collectHassActions(): HassActionDetail[] {
  const seen: HassActionDetail[] = [];
  const listener = (event: Event): void => {
    seen.push((event as CustomEvent<HassActionDetail>).detail);
  };
  document.addEventListener('hass-action', listener);
  hassActionCleanups.push(() => document.removeEventListener('hass-action', listener));
  return seen;
}

let hassActionCleanups: (() => void)[] = [];

function pointer(type: string, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    composed: true,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 40,
    clientY: 40,
    ...init,
  });
}

function tapOn(target: HTMLElement): void {
  target.dispatchEvent(pointer('pointerdown'));
  target.dispatchEvent(pointer('pointerup'));
}

afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll(CARD_TAG).forEach((card) => card.remove());
  for (const undo of hassActionCleanups) undo();
  hassActionCleanups = [];
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
      transport: 'mse',
      overlay: 'none',
      tap_action: { action: 'more-info' },
      hold_action: { action: 'none' },
      double_tap_action: { action: 'none' },
      aspect_ratio: '16 / 9',
      reload_after_minutes_down: 0,
    });
  });

  it('preserves unknown keys that Lovelace injects', () => {
    const config = normalizeConfig({ ...base, grid_options: { columns: 6 } });
    expect(config.grid_options).toEqual({ columns: 6 });
  });
});

describe('normalizeConfig — enums', () => {
  it('accepts both transports', () => {
    expect(normalizeConfig({ ...base, transport: 'webrtc' }).transport).toBe('webrtc');
    expect(normalizeConfig({ ...base, transport: 'mse' }).transport).toBe('mse');
  });

  it('rejects an unknown transport', () => {
    expect(() => normalizeConfig({ ...base, transport: 'hls' })).toThrow(
      /"transport" must be one of/,
    );
  });

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

describe('SimplerCameraCard element', () => {
  it('is registered under the card tag', () => {
    expect(customElements.get(CARD_TAG)).toBe(SimplerCameraCard);
  });

  it('reports sizes for both view types', () => {
    const card = new SimplerCameraCard();
    expect(card.getCardSize()).toBeGreaterThan(0);
    expect(SimplerCameraCard.getGridOptions()).toMatchObject({ columns: 12, min_columns: 6 });
  });

  it('setConfig propagates validation errors to Lovelace', () => {
    const card = new SimplerCameraCard();
    expect(() => card.setConfig({ type: CARD_TYPE })).toThrow(/"camera" is required/);
    expect(() => card.setConfig(base)).not.toThrow();
  });

  it('getStubConfig prefers a camera exposing camera_name', () => {
    const hass = fakeHass(
      cameraEntity('camera.generic', { friendly_name: 'Generic' }),
      cameraEntity('camera.frigate_one'),
    );
    expect(SimplerCameraCard.getStubConfig(hass)).toEqual({
      type: CARD_TYPE,
      camera: 'camera.frigate_one',
    });
  });

  it('getStubConfig falls back gracefully with no cameras at all', () => {
    expect(SimplerCameraCard.getStubConfig(fakeHass()).camera).toMatch(/^camera\./);
  });

  it('accepts transport: webrtc', () => {
    const card = new SimplerCameraCard();
    expect(normalizeConfig({ ...base, transport: 'webrtc' }).transport).toBe('webrtc');
    expect(() => card.setConfig({ ...base, transport: 'webrtc' })).not.toThrow();
  });

  it('builds a WebRTC player for transport: webrtc, and an MSE one otherwise', async () => {
    // The factory is internal, so it is observed through what each player
    // actually opens: the WebRTC one creates an RTCPeerConnection, the MSE one
    // a MediaSource. Both are read off the globals, which is what makes this a
    // test of the real wiring rather than of an injected double.
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.stubGlobal('MediaSource', FakeMediaSource);
    const restoreObjectUrl = installObjectUrlStubs();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    FakeWebSocket.reset();
    FakePeerConnection.reset();
    FakeMediaSource.reset();

    try {
      const webrtcCard = mountCard({ ...base, transport: 'webrtc' }, { endpoint: stubEndpoint() });
      await settle(webrtcCard);
      expect(FakePeerConnection.instances).toHaveLength(1);
      expect(FakeMediaSource.instances).toHaveLength(0);
      expect(FakeWebSocket.last().url).toBe(WS_URL);
      webrtcCard.remove();

      const mseCard = mountCard({ ...base, transport: 'mse' }, { endpoint: stubEndpoint() });
      await settle(mseCard);
      expect(FakePeerConnection.instances).toHaveLength(1);
      expect(FakeMediaSource.instances).toHaveLength(1);
      mseCard.remove();
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
    const { players, create } = playerFactory();
    const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
    await settle(card);

    expect(players).toHaveLength(1);
    expect(players[0].url).toBe(WS_URL);
    expect(players[0].video).toBe(card.shadowRoot!.querySelector('video'));
  });

  it('waits for hass before starting, whatever order things arrive in', async () => {
    const { players, create } = playerFactory();
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
    const { players, create } = playerFactory();
    const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
    await settle(card);

    card.remove();
    expect(players[0].destroyed).toBe(true);
  });

  it('rebuilds the supervisor when setConfig changes the stream', async () => {
    const { players, create } = playerFactory();
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

    card.hass = fakeHass(cameraEntity('camera.front_yard', { camera_name: 'front_yard' }));
    await settle(card);

    expect(card.shadowRoot!.querySelector('video')).toBe(video);
  });

  it('hides the poster and the status pill while playing', async () => {
    const { players, create } = playerFactory();
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
    const { players, create } = playerFactory();
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
    const { players, create } = playerFactory();
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
      const { players, create } = playerFactory();
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
    const { players, create } = playerFactory();
    const card = mountCard(base, { createPlayer: create, endpoint: stubEndpoint() });
    await settle(card);

    players[0].onDead('ws-close');
    await settle(card);
    expect(players).toHaveLength(1);

    window.dispatchEvent(new Event('online'));
    await settle(card);
    expect(players).toHaveLength(2);
  });

  it('drops its listeners when disconnected', async () => {
    vi.useFakeTimers();
    const { players, create } = playerFactory();
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
    const fired = collectHassActions();
    const card = mountCard(
      { ...base, hold_action: { action: 'navigate', navigation_path: '/lovelace/cams' } },
      { endpoint: neverResolves() },
    );
    await settle(card);

    tapOn(container(card));

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
    const card = mountCard(base, { endpoint: neverResolves() });
    await settle(card);

    const targets: EventTarget[] = [];
    document.addEventListener('hass-action', (event) => targets.push(event.target!), {
      once: true,
    });
    tapOn(container(card));

    expect(targets).toEqual([card]);
  });

  it('recognises hold and double-tap once they are configured', async () => {
    vi.useFakeTimers();
    const fired = collectHassActions();
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

    tapOn(surface);
    tapOn(surface);
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 2);

    expect(fired.map((detail) => detail.action)).toEqual(['hold', 'double_tap']);
  });

  it('picks up a config edit without being re-wired', async () => {
    const fired = collectHassActions();
    const card = mountCard(base, { endpoint: neverResolves() });
    await settle(card);

    card.setConfig({ ...base, tap_action: { action: 'toggle' } });
    await settle(card);
    tapOn(container(card));

    expect(fired[0].config.tap_action).toEqual({ action: 'toggle' });
  });

  it('exposes button semantics only while the tap action does something', async () => {
    const card = mountCard(base, { endpoint: neverResolves() });
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
    const fired = collectHassActions();
    const card = mountCard(base, { endpoint: neverResolves() });
    await settle(card);

    container(card).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(fired.map((detail) => detail.action)).toEqual(['tap']);
  });

  it('stops listening once the card leaves the DOM, and listens again on return', async () => {
    const fired = collectHassActions();
    const card = mountCard(base, { endpoint: neverResolves() });
    await settle(card);
    const surface = container(card);

    card.remove();
    tapOn(surface);
    expect(fired).toEqual([]);

    document.body.appendChild(card);
    await settle(card);
    tapOn(container(card));
    expect(fired.map((detail) => detail.action)).toEqual(['tap']);
  });
});

describe('SimplerCameraCard — poster', () => {
  it('refreshes the signed snapshot while down, and stops once playing', async () => {
    vi.useFakeTimers();
    let issued = 0;
    const { players, create } = playerFactory();
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

  it('never lets a poster failure take the card down', async () => {
    const { players, create } = playerFactory();
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
});
