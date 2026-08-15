/**
 * `tests/integration/harness.ts` — the browser side of the go2rtc integration
 * test.
 *
 * This runs the **real card**: `src/card.ts` builds a real
 * `StreamSupervisorImpl` driving a real `MsePlayer` over a real `Go2rtcClient`
 * against the local go2rtc process. Nothing about the player, the protocol, the
 * watchdog or the retry ladder is stubbed.
 *
 * Exactly one thing is substituted — the {@link EndpointResolver} — through the
 * card's documented `supervisorOverrides` test seam. Home Assistant is the only
 * part of the stack this rig cannot host, and its whole contribution to a
 * connection attempt is "produce a signed URL"; that logic is covered by
 * `tests/endpoint.test.ts` against a mock `hass`. So the resolver here simply
 * hands back the bare go2rtc URLs passed in the query string, and `types.ts` is
 * untouched.
 *
 * The Node side observes the card the way a user would: through the rendered
 * status pill, the poster layer and `video.currentTime`.
 */

import '../../src/card';
import { CARD_TAG, CARD_TYPE, type CameraEntity, type HomeAssistant } from '../../src/types';

/** A snapshot of everything the Node-side test asserts on. */
export interface HarnessProbe {
  /** Status pill text, or `null` when the card is showing live video. */
  status: string | null;
  /** Poster `src`, or `null` when the card is showing live video. */
  poster: string | null;
  /** The card's own `console.info` lines — death reasons and retry decisions. */
  log: string[];
  currentTime: number;
  readyState: number;
  paused: boolean;
  videoWidth: number;
  /** Whether this browser can decode the H.264 the test pattern is encoded in. */
  mseH264: boolean;
}

declare global {
  interface Window {
    /** Installed by this module; called from Playwright via `page.evaluate`. */
    __harness: {
      probe(): HarnessProbe;
      reset(): void;
    };
  }
}

const params = new URLSearchParams(location.search);
const wsUrl = params.get('ws') ?? '';
const posterUrl = params.get('poster') ?? '';

const log: string[] = [];

/*
 * The card reports every reliability decision at `console.info` with a
 * `[simpler-camera-card]` prefix — that is its field-debugging surface, so the
 * test asserts on the same thing an operator would read. Capturing it here is
 * how the Node side learns *why* a stream died.
 */
const originalInfo = console.info.bind(console);
console.info = (...args: unknown[]): void => {
  const line = args.map((arg) => String(arg)).join(' ');
  if (line.includes('[simpler-camera-card]')) log.push(line);
  originalInfo(...args);
};

const entity: CameraEntity = {
  entity_id: 'camera.test',
  state: 'streaming',
  attributes: {
    client_id: 'integration',
    camera_name: 'test',
    friendly_name: 'Test Pattern',
  },
};

/**
 * A `hass` object with everything the card reads and nothing it can call: the
 * endpoint override means `callWS` is never reached, and this makes that
 * explicit rather than silently returning a fake signature.
 */
const hass: HomeAssistant = {
  states: { 'camera.test': entity },
  connected: true,
  connection: {} as HomeAssistant['connection'],
  callWS: () => Promise.reject(new Error('the harness signs nothing; the resolver is stubbed')),
};

const card = document.createElement(CARD_TAG);

card.supervisorOverrides = {
  endpoint: {
    // Signed per attempt in production; here the URL is simply constant.
    resolveSignedWsUrl: () => Promise.resolve(wsUrl),
    // A real JPEG from go2rtc, cache-busted the way a rotating HA token would
    // be — so a refresh is observable, and a failed fetch is a real failure.
    resolvePosterUrl: () => Promise.resolve(`${posterUrl}&t=${Date.now()}`),
  },
};

card.setConfig({ type: CARD_TYPE, camera: 'camera.test', overlay: 'name' });
card.hass = hass;
document.body.appendChild(card);

window.__harness = {
  probe(): HarnessProbe {
    const root = card.shadowRoot;
    const video = root?.querySelector('video') ?? null;
    return {
      status: root?.querySelector('.status')?.textContent?.trim() ?? null,
      poster: root?.querySelector('img.poster')?.getAttribute('src') ?? null,
      log: log.slice(-40),
      currentTime: video?.currentTime ?? 0,
      readyState: video?.readyState ?? 0,
      paused: video?.paused ?? true,
      videoWidth: video?.videoWidth ?? 0,
      mseH264:
        typeof MediaSource !== 'undefined' &&
        MediaSource.isTypeSupported('video/mp4; codecs="avc1.640029"'),
    };
  },
  reset(): void {
    log.length = 0;
  },
};
