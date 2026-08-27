/**
 * `types.ts` — the shared contract for Simpler Camera Card.
 *
 * This module is the single source of truth for every interface that crosses a
 * module boundary: the YAML config schema, the minimal Home Assistant surface
 * the card touches, the player/supervisor/endpoint interfaces, and the retry
 * constants that both the reliability layer and its tests read.
 *
 * Rules for this file:
 *
 * - **Types and constants only.** No runtime behaviour beyond `const` values.
 *   Everything here is imported by every other module; it must have no
 *   dependencies of its own beyond type-only imports.
 * - **Every interface documents who implements it and who consumes it.**
 *   Modules are built in parallel against these declarations, so an
 *   under-specified shape becomes a merge conflict later.
 * - **Frozen.** Later slices implement against this file rather than editing
 *   it. Treat it as a published API.
 *
 * Type-only imports from `home-assistant-js-websocket` are safe: the package is
 * a devDependency and never appears in the shipped bundle.
 */

import type { Connection, MessageBase } from 'home-assistant-js-websocket';

/* -------------------------------------------------------------------------- */
/* Card identity                                                               */
/* -------------------------------------------------------------------------- */

/** Custom element tag name, and the suffix of the `custom:` YAML card type. */
export const CARD_TAG = 'simpler-camera-card';

/** The value users write as `type:` in YAML. */
export const CARD_TYPE = `custom:${CARD_TAG}`;

/* -------------------------------------------------------------------------- */
/* Minimal Home Assistant surface                                              */
/* -------------------------------------------------------------------------- */

/**
 * The camera entity attributes this card reads.
 *
 * A Frigate camera entity (frigate-hass-integration >= 5.12.0) exposes exactly
 * `client_id` and `camera_name`; both are required to build the go2rtc
 * endpoint. `entity_picture` is the standard HA snapshot URL and `friendly_name`
 * backs the `overlay: name` label.
 *
 * Everything is optional because `hass.states` is untrusted input — the card
 * validates presence and reports a helpful error rather than crashing.
 */
export interface CameraEntityAttributes {
  /** Frigate integration config-entry id; first path segment of the proxy URL. */
  client_id?: string;
  /** Frigate's own camera name, which is also the default go2rtc stream name. */
  camera_name?: string;
  /** HA-signed snapshot URL (token rotates every ~5 min). */
  entity_picture?: string;
  /** Display name, used by `overlay: name`. */
  friendly_name?: string;
  /** Other attributes exist; the card ignores them. */
  [key: string]: unknown;
}

/** The subset of an HA state object this card reads. */
export interface CameraEntity {
  entity_id: string;
  state: string;
  attributes: CameraEntityAttributes;
}

/**
 * The subset of Home Assistant's `hass` object this card uses.
 *
 * Deliberately minimal — the card takes no dependency on `custom-card-helpers`
 * (a lagging vendored snapshot of the frontend types). A real `hass` object is
 * structurally assignable to this interface.
 *
 * Consumed by: `card.ts`, `endpoint.ts`, `reliability/supervisor.ts`.
 */
export interface HomeAssistant {
  /** Entity registry snapshot; a new object arrives on every state change. */
  states: Record<string, CameraEntity>;
  /** Live websocket connection (used for subscriptions, not for `callWS`). */
  connection: Connection;
  /**
   * Whether the HA websocket is currently up. The false -> true edge is one of
   * the six reconnect triggers (see {@link DeathReason}).
   */
  connected: boolean;
  /** Fire-and-await a websocket command; used for `auth/sign_path`. */
  callWS<T>(msg: MessageBase): Promise<T>;
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * HA-standard action names. The card does not implement these itself — it fires
 * the `hass-action` event and lets the frontend run the whole pipeline
 * (confirmations, more-info dialog, navigation, service calls).
 */
export type ActionName =
  'more-info' | 'toggle' | 'navigate' | 'url' | 'perform-action' | 'assist' | 'none';

/** Optional confirmation prompt, passed through to HA verbatim. */
export interface ActionConfirmationConfig {
  text?: string;
  exemptions?: { user: string }[];
}

/**
 * A minimal, local mirror of HA's action config object.
 *
 * Only the fields the card needs to *carry* are typed; HA consumes the rest.
 * Unknown keys are permitted so future HA action options pass through
 * untouched.
 *
 * Consumed by: `card.ts` / `actions.ts` (slice 6).
 */
export interface ActionConfig {
  action: ActionName;
  /** `more-info` / `toggle` target; defaults to the card's camera entity. */
  entity?: string;
  /** `navigate`. */
  navigation_path?: string;
  navigation_replace?: boolean;
  /** `url`. */
  url_path?: string;
  /** `perform-action`. */
  perform_action?: string;
  target?: Record<string, unknown>;
  data?: Record<string, unknown>;
  /** Optional confirmation prompt. */
  confirmation?: boolean | ActionConfirmationConfig;
  /** Forward-compatibility: unrecognised options are passed through. */
  [key: string]: unknown;
}

/** Every value accepted for `action:`; used by config validation. */
export const ACTION_NAMES: readonly ActionName[] = [
  'more-info',
  'toggle',
  'navigate',
  'url',
  'perform-action',
  'assist',
  'none',
];

/* -------------------------------------------------------------------------- */
/* Card configuration                                                          */
/* -------------------------------------------------------------------------- */

/** Overlay label mode. */
export type OverlayMode = 'none' | 'name' | 'custom';

/** Accepted `overlay:` values; used by config validation. */
export const OVERLAY_MODES: readonly OverlayMode[] = ['none', 'name', 'custom'];

/**
 * The card's YAML config exactly as the user writes it — every optional field
 * is genuinely optional here.
 *
 * ```yaml
 * type: custom:simpler-camera-card
 * camera: camera.front_yard
 * stream: front_yard_sub
 * overlay: name
 * overlay_text: "Front Yard"
 * tap_action: { action: more-info }
 * hold_action: { action: none }
 * double_tap_action: { action: none }
 * aspect_ratio: "16:9"
 * reload_after_minutes_down: 0
 * ```
 *
 * Produced by: Lovelace. Validated and normalized by `card.ts`.
 */
export interface SimplerCameraCardConfig {
  /** Always `custom:simpler-camera-card`. */
  type: string;
  /** Required. HA camera entity id from the Frigate integration. */
  camera: string;
  /** go2rtc stream name; defaults to the entity's `camera_name` attribute. */
  stream?: string;
  /** Default `none`. */
  overlay?: OverlayMode;
  /** Label text for `overlay: custom` (required in that mode). */
  overlay_text?: string;
  /** Default `{ action: 'more-info' }`. */
  tap_action?: ActionConfig;
  /** Default `{ action: 'none' }`. */
  hold_action?: ActionConfig;
  /** Default `{ action: 'none' }`. */
  double_tap_action?: ActionConfig;
  /** `"W:H"` (e.g. `"16:9"`) or a bare number. Default `"16:9"`. */
  aspect_ratio?: string | number;
  /**
   * Escape hatch: `location.reload()` after N consecutive minutes down.
   * `0` (default) disables it.
   */
  reload_after_minutes_down?: number;
  /**
   * Lovelace injects its own keys (`view_layout`, `grid_options`,
   * `visibility`, ...). They are ignored, not rejected.
   */
  [key: string]: unknown;
}

/**
 * The config after validation, with every default applied.
 *
 * This — not the raw config — is what the card, supervisor and endpoint
 * resolver consume, so downstream code never repeats a default.
 *
 * Produced by: `normalizeConfig()` in `card.ts`.
 */
export interface NormalizedCardConfig extends SimplerCameraCardConfig {
  type: string;
  camera: string;
  overlay: OverlayMode;
  tap_action: ActionConfig;
  hold_action: ActionConfig;
  double_tap_action: ActionConfig;
  /** Normalized to a CSS `aspect-ratio` value, e.g. `"16 / 9"`. */
  aspect_ratio: string;
  reload_after_minutes_down: number;
}

/** Defaults applied by `normalizeConfig()`. Exported so tests assert on them. */
export const CONFIG_DEFAULTS = {
  overlay: 'none' as OverlayMode,
  aspectRatio: '16 / 9',
  tapAction: { action: 'more-info' } as ActionConfig,
  holdAction: { action: 'none' } as ActionConfig,
  doubleTapAction: { action: 'none' } as ActionConfig,
  reloadAfterMinutesDown: 0,
} as const;

/* -------------------------------------------------------------------------- */
/* Death reasons                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Why a live stream is considered dead. Every reconnect trigger from the spec's
 * Key Decisions table maps onto exactly one of these values, and all of them
 * funnel into the supervisor's single `onDead(reason)` entry point. The reason
 * is logged at `info` for field debugging.
 *
 * | Trigger (spec)                              | Value                |
 * | ------------------------------------------- | -------------------- |
 * | (a) go2rtc WebSocket closed                 | `ws-close`           |
 * | (a) go2rtc WebSocket errored                | `ws-error`           |
 * | (b) `<video>` / SourceBuffer media error    | `media-error`        |
 * | (c) frame-stall watchdog fired              | `stall`              |
 * | (d) `hass.connected` false -> true edge     | `hass-reconnected`   |
 * | (e) `resume` / `pageshow` / `online`        | `page-resumed`       |
 * | (f) MSE handshake timed out (5 s)           | `handshake-timeout`  |
 *
 * Reported by: players (`ws-*`, `media-error`, `handshake-timeout`) and the
 * watchdog (`stall`); synthesised by the supervisor for the external events
 * (`hass-reconnected`, `page-resumed`).
 */
export type DeathReason =
  | 'ws-close'
  | 'ws-error'
  | 'media-error'
  | 'stall'
  | 'hass-reconnected'
  | 'page-resumed'
  | 'handshake-timeout';

/* -------------------------------------------------------------------------- */
/* Player contract                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A single live-stream attempt.
 *
 * **Lifecycle is one-shot.** A player is constructed per connection attempt and
 * discarded once dead — it is never revived, restarted, or reused. This is what
 * makes tier-2 recovery a clean "replace the whole player" operation and keeps
 * every player free of internal retry logic.
 *
 * Implemented by: `player/mse-player.ts` (slice 3).
 * Consumed by: `reliability/supervisor.ts` (slice 4) — nothing else constructs
 * or drives a player.
 */
export interface LivePlayer {
  /**
   * Begin connecting. Called exactly once, immediately after construction and
   * after the callbacks below have been assigned.
   *
   * @param video       the (already mounted) media element to feed
   * @param signedWsUrl absolute `ws(s)://` go2rtc URL, freshly signed for this
   *                    attempt — the player must not re-derive or re-sign it
   */
  mount(video: HTMLVideoElement, signedWsUrl: string): void;

  /**
   * Tear everything down: close the socket, detach MediaSource / close the
   * peer connection, drop listeners and timers. Must be idempotent and safe to
   * call before `mount()`, after `onDead`, or twice in a row. Must not invoke
   * `onDead`.
   */
  destroy(): void;

  /**
   * Playback has actually started (first frame presented). Set by the
   * supervisor before `mount()`. May fire more than once; the supervisor
   * treats repeats as no-ops.
   */
  onPlaying: () => void;

  /**
   * This attempt is dead. Set by the supervisor before `mount()`.
   *
   * **Fire-once per player instance**: after invoking it the player must never
   * call either callback again. The player does not attempt its own recovery —
   * the supervisor decides what happens next.
   */
  onDead: (reason: DeathReason) => void;
}

/**
 * Constructs a player for one attempt.
 *
 * Exists so the supervisor never imports a concrete player module (which keeps
 * the supervisor's tests free of MSE plumbing and lets them inject fakes).
 *
 * Implemented by: `card.ts` (slice 5). Consumed by: the supervisor.
 */
export type PlayerFactory = () => LivePlayer;

/* -------------------------------------------------------------------------- */
/* Supervisor contract                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Supervisor states.
 *
 * ```text
 * idle -> connecting -> playing
 *            ^  |          |
 *            |  v          v
 *    retrying (tier 1, <=3 x 2 s) -> remounting (tier 2, jittered backoff)
 * ```
 * Any state returns to `idle` on `stop()`.
 *
 * - `connecting`  — a player is mounted, waiting for first frame.
 * - `playing`     — frames are being presented; watchdog armed.
 * - `retrying`    — tier 1: fast in-place retry, poster shown dimmed.
 * - `remounting`  — tier 2: whole player replaced after a backoff delay.
 */
export type SupervisorState = 'idle' | 'connecting' | 'playing' | 'retrying' | 'remounting';

/** Optional context for a state change, used by the card's status indicator. */
export interface SupervisorStateDetail {
  /** Why the previous attempt died (absent on the first `connecting`). */
  reason?: DeathReason;
  /** 1-based attempt counter within the current tier. */
  attempt?: number;
  /** Milliseconds until the next attempt (tier-1 delay or tier-2 backoff). */
  delayMs?: number;
  /** Milliseconds since the stream was last `playing`, for the escape hatch. */
  downForMs?: number;
  /** Human-readable detail (e.g. an endpoint/config error message). */
  message?: string;
}

/**
 * Events the card observes and forwards to the supervisor. The supervisor owns
 * what each one means; the card only reports them.
 *
 * - `hass-reconnected`   — `hass.connected` went false -> true.
 * - `page-resumed`       — `resume` / `pageshow` / `online` after a freeze.
 * - `visibility-hidden`  — document hidden (teardown after a 5 s grace).
 * - `visibility-visible` — document visible again (reconnect).
 */
export type SupervisorExternalEvent =
  'hass-reconnected' | 'page-resumed' | 'visibility-hidden' | 'visibility-visible';

/**
 * Owns the connection state machine: player lifecycle, the watchdog, both retry
 * tiers, and every reconnect trigger. Retries forever — kiosk semantics.
 *
 * Implemented by: `reliability/supervisor.ts` (slice 4).
 * Consumed by: `card.ts` (slice 5).
 */
export interface StreamSupervisor {
  /** Enter `connecting` and begin the first attempt. No-op if already started. */
  start(): void;

  /**
   * Tear down the current player, cancel all timers, return to `idle`.
   * Idempotent.
   */
  stop(): void;

  /** Report a lifecycle / connectivity event. See {@link SupervisorExternalEvent}. */
  notifyExternalEvent(ev: SupervisorExternalEvent): void;

  /**
   * Called on every state transition so the card can render status, poster and
   * the escape-hatch countdown. Assigned by the card before `start()`.
   */
  onStateChange: (state: SupervisorState, detail?: SupervisorStateDetail) => void;
}

/* -------------------------------------------------------------------------- */
/* Reliability constants                                                       */
/* -------------------------------------------------------------------------- */

/*
 * Shared by `reliability/retry.ts`, `reliability/watchdog.ts`, the players and
 * their tests, so a policy change happens in exactly one place. Values come
 * from the spec's Key Decisions table (originally ACC v8.0.0-rc.4 constants).
 */

/** Tier 1: fast in-place retries before escalating to a full remount. */
export const TIER1_MAX_RETRIES = 3;

/** Tier 1: fixed delay between in-place retries. */
export const TIER1_RETRY_DELAY_MS = 2_000;

/** Tier 2: first remount delay. */
export const REMOUNT_BACKOFF_BASE_MS = 5_000;

/** Tier 2: multiplier applied per consecutive failed remount. */
export const REMOUNT_BACKOFF_FACTOR = 2;

/** Tier 2: upper bound on the (pre-jitter) backoff delay. */
export const REMOUNT_BACKOFF_CAP_MS = 600_000;

/** Tier 2 jitter: delay is multiplied by a uniform sample from this range. */
export const REMOUNT_BACKOFF_JITTER_MIN = 0.5;
export const REMOUNT_BACKOFF_JITTER_MAX = 1.0;

/** Watchdog: no presented frame for this long (while playback is expected) => dead. */
export const WATCHDOG_STALL_TIMEOUT_MS = 10_000;

/** Player: no first frame within this long after `mount()` => `handshake-timeout`. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** Lifecycle: grace period after `visibility-hidden` before tearing down. */
export const HIDDEN_TEARDOWN_GRACE_MS = 5_000;

/** Poster: refresh the snapshot this often while the stream is down. */
export const POSTER_REFRESH_INTERVAL_MS = 10_000;

/* -------------------------------------------------------------------------- */
/* Endpoint contract                                                           */
/* -------------------------------------------------------------------------- */

/** Machine-readable failure classes from the endpoint resolver. */
export type EndpointErrorCode =
  /** `config.camera` names an entity that is not in `hass.states`. */
  | 'entity-not-found'
  /** The entity exists but `client_id` is neither present nor cached from a
   *  past resolution (not a Frigate camera, or unavailable since page load). */
  | 'missing-client-id'
  /** No `stream` in config and the entity lacks `camera_name`. */
  | 'missing-stream-name'
  /** `auth/sign_path` failed or returned an unusable response. */
  | 'sign-failed';

/**
 * Turns config + hass state into freshly signed, absolute URLs.
 *
 * **Never cache.** Both methods sign on every call:
 * - the go2rtc `authSig` must be minted per connection attempt so the stream
 *   survives an HA restart rotating the signing key (this is root cause #4 of
 *   the card this one replaces);
 * - a camera snapshot's `access_token` rotates every ~5 minutes.
 *
 * Implemented by: `endpoint.ts`.
 * Consumed by: `card.ts` and `reliability/supervisor.ts` (once per attempt).
 *
 * Rejections are `EndpointError` (see `endpoint.ts`) carrying an
 * {@link EndpointErrorCode}.
 */
export interface EndpointResolver {
  /**
   * Absolute `ws://` / `wss://` URL for the go2rtc websocket, signed for this
   * attempt.
   */
  resolveSignedWsUrl(hass: HomeAssistant, config: SimplerCameraCardConfig): Promise<string>;

  /**
   * Absolute `http(s)://` URL for a fresh camera snapshot, or `null` when the
   * entity is missing (the card then simply shows no poster).
   */
  resolvePosterUrl(hass: HomeAssistant, config: SimplerCameraCardConfig): Promise<string | null>;
}

/* -------------------------------------------------------------------------- */
/* Card registry                                                               */
/* -------------------------------------------------------------------------- */

/** One entry in Home Assistant's custom-card picker registry. */
export interface CustomCardEntry {
  type: string;
  name: string;
  description: string;
  preview?: boolean;
  documentationURL?: string;
}

declare global {
  interface Window {
    customCards?: CustomCardEntry[];
  }
}
