/**
 * Test fixtures shared across the suite.
 *
 * What lives here: the doubles that are not about one module in particular —
 * a normalized config, a `hass` object, a camera entity, the `Image` the
 * snapshot path preloads into, pointer gestures, and the `hass-action`
 * collector. They were each written three or four times over before landing
 * here, and every copy had to be kept in step by hand.
 *
 * What does not: doubles that model one layer's collaborators. The browser
 * APIs the player drives (`WebSocket`, MediaSource, object URLs) stay in
 * `tests/player/stubs.ts`; the reliability layer's player, watchdog and
 * endpoint doubles stay in `tests/reliability/doubles.ts`. A double belongs
 * here once a second layer needs it, not before.
 *
 * `tests/integration/` deliberately imports none of this: it bundles into a
 * real browser page, where `vitest` (and therefore `vi`, used below) has no
 * business being.
 */

import { vi } from 'vitest';
import type { HassActionDetail } from '../src/actions';
import {
  CARD_TYPE,
  CONFIG_DEFAULTS,
  type CameraEntity,
  type HomeAssistant,
  type NormalizedCardConfig,
  type SimplerCameraCardConfig,
} from '../src/types';

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A normalized config shaped like `normalizeConfig()`'s output, built from the
 * same {@link CONFIG_DEFAULTS} the production path applies so a changed default
 * cannot silently drift away from what the tests assume.
 *
 * One deliberate deviation: `tap_action` is set explicitly (not the `none`
 * default) so gesture-adjacent code under test always has something to fire.
 */
export function fakeConfig(overrides: Partial<NormalizedCardConfig> = {}): NormalizedCardConfig {
  return {
    type: CARD_TYPE,
    camera: 'camera.front_yard',
    overlay: CONFIG_DEFAULTS.overlay,
    tap_action: { action: 'more-info' },
    hold_action: CONFIG_DEFAULTS.holdAction,
    double_tap_action: CONFIG_DEFAULTS.doubleTapAction,
    aspect_ratio: CONFIG_DEFAULTS.aspectRatio,
    reload_after_minutes_down: CONFIG_DEFAULTS.reloadAfterMinutesDown,
    mode: CONFIG_DEFAULTS.mode,
    refresh_interval: CONFIG_DEFAULTS.refreshInterval,
    tap_to_live: CONFIG_DEFAULTS.tapToLive,
    live_duration: CONFIG_DEFAULTS.liveDuration,
    ...overrides,
  };
}

/**
 * Every configurable key, spelled out as a real config object so TypeScript's
 * excess-property checking catches a typo here. The `type` key is excluded from
 * {@link CONFIG_KEYS}: it is the card identity, not a user setting, and
 * Lovelace owns it.
 */
export const EVERY_OPTION: SimplerCameraCardConfig = {
  type: CARD_TYPE,
  camera: 'camera.front_yard',
  stream: 'front_yard_sub',
  overlay: 'custom',
  overlay_text: 'Front Yard',
  tap_action: { action: 'more-info' },
  hold_action: { action: 'none' },
  double_tap_action: { action: 'none' },
  aspect_ratio: '16:9',
  reload_after_minutes_down: 30,
  mode: 'snapshot',
  refresh_interval: 4,
  tap_to_live: true,
  live_duration: 30,
};

/** The user-settable config keys: what the editor and the README must cover. */
export const CONFIG_KEYS = Object.keys(EVERY_OPTION).filter((key) => key !== 'type');

/* -------------------------------------------------------------------------- */
/* Home Assistant                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A Frigate camera entity as the integration actually exposes it. Attributes
 * merge over the Frigate ones, so `{ camera_name: undefined }` is how a test
 * says "this camera is not a Frigate camera".
 */
export function cameraEntity(
  attributes: Partial<CameraEntity['attributes']> = {},
  entity_id = 'camera.front_yard',
): CameraEntity {
  return {
    entity_id,
    state: 'streaming',
    attributes: {
      client_id: 'frigate',
      camera_name: 'front_yard',
      friendly_name: 'Front Yard',
      ...attributes,
    },
  };
}

/**
 * A `hass` stub carrying the given entities and nothing else. `callWS` answers
 * every command with `{}`: code that needs a real signature (the endpoint
 * resolver) brings its own double.
 */
export function fakeHass(...entities: CameraEntity[]): HomeAssistant {
  return {
    states: Object.fromEntries(entities.map((entity) => [entity.entity_id, entity])),
    connected: true,
    callWS: (async () => ({})) as unknown as HomeAssistant['callWS'],
  };
}

/* -------------------------------------------------------------------------- */
/* Image preloading                                                            */
/* -------------------------------------------------------------------------- */

/** What a preloaded image does when its `src` is assigned. */
export type ImageBehaviour = 'load' | 'error' | 'hold';

/**
 * The parts of `HTMLImageElement` the snapshot path touches. happy-dom never
 * fetches anything, so a preload only ever resolves because this says so.
 *
 * Behaviour comes from the instance when a test sets one (it injected the
 * image itself) and from the static otherwise (the code under test built the
 * image through a stubbed global — see {@link installImageStub}). Both are read
 * when the preload settles, so a test can flip the static mid-flight.
 */
export class FakeImage {
  /** The default for images the code under test constructs itself. */
  static behaviour: ImageBehaviour = 'load';

  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** Per-instance override, for tests that inject the image directly. */
  behaviour: ImageBehaviour | undefined;
  private value = '';

  get src(): string {
    return this.value;
  }

  set src(next: string) {
    this.value = next;
    if (next === '') return;
    queueMicrotask(() => {
      const behaviour = this.behaviour ?? FakeImage.behaviour;
      if (behaviour === 'load') this.onload?.();
      else if (behaviour === 'error') this.onerror?.();
      // 'hold': the test decides, with finishLoad() / finishError().
    });
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

/** Stand {@link FakeImage} in for the global `Image` for the current test. */
export function installImageStub(behaviour: ImageBehaviour = 'load'): void {
  FakeImage.behaviour = behaviour;
  vi.stubGlobal('Image', FakeImage);
}

/* -------------------------------------------------------------------------- */
/* Gestures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A primary-button pointer event at (100, 100). The coordinates only ever
 * matter relative to each other — the tap-slop tests pass their own.
 */
export function pointer(type: string, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    composed: true,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 100,
    clientY: 100,
    ...init,
  });
}

/** A complete press-and-release at one spot. */
export function tap(target: HTMLElement, init: PointerEventInit = {}): void {
  target.dispatchEvent(pointer('pointerdown', init));
  target.dispatchEvent(pointer('pointerup', init));
}

/* -------------------------------------------------------------------------- */
/* hass-action                                                                 */
/* -------------------------------------------------------------------------- */

let hassActionCleanups: (() => void)[] = [];

/** Listen at the document until {@link releaseHassActions}. */
function onHassAction(handler: (event: CustomEvent<HassActionDetail>) => void): void {
  const listener = (event: Event): void => handler(event as CustomEvent<HassActionDetail>);
  document.addEventListener('hass-action', listener);
  hassActionCleanups.push(() => document.removeEventListener('hass-action', listener));
}

/** Collect every `hass-action` event that reaches the document, in order. */
export function collectHassActions(): CustomEvent<HassActionDetail>[] {
  const seen: CustomEvent<HassActionDetail>[] = [];
  onHassAction((event) => seen.push(event));
  return seen;
}

/** The same, reduced to the `detail` most assertions are about. */
export function collectHassActionDetails(): HassActionDetail[] {
  const seen: HassActionDetail[] = [];
  onHassAction((event) => seen.push(event.detail));
  return seen;
}

/** Drop every collector's listener. Call from `afterEach`. */
export function releaseHassActions(): void {
  for (const undo of hassActionCleanups) undo();
  hassActionCleanups = [];
}
