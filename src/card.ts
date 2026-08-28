/**
 * `card.ts` — the `simpler-camera-card` custom element.
 *
 * The card owns three things and delegates everything else:
 *
 * 1. **Config** — validation, defaults and the errors Lovelace shows the user.
 * 2. **Wiring** — under `mode: live` it builds the one
 *    {@link StreamSupervisorImpl} that owns the connection state machine, hands
 *    it the real {@link endpointResolver}, a {@link PlayerFactory} and getters
 *    for `hass` / `<video>` / config, then reports page-lifecycle facts to it
 *    (`visibilitychange`, `pageshow`, `online`, `resume`, and the
 *    `hass.connected` false→true edge). Under `mode: snapshot` it builds a
 *    {@link SnapshotLoop} instead — no supervisor, no player, no watchdog, no
 *    `<video>` — and routes the same lifecycle facts to `pause()` / `resume()` /
 *    `refreshNow()`. With `tap_to_live`, a tap swaps a snapshot card onto the
 *    live stack for `live_duration` seconds and back again — one flag
 *    (`_temporaryLive`) picking the *effective* mode, over machinery that is
 *    already built to be torn down and rebuilt.
 * 3. **Degraded UX** — while the stream is not `playing` it shows the latest
 *    camera snapshot, dimmed, with a small status indicator; the snapshot is
 *    re-signed and refreshed every {@link POSTER_REFRESH_INTERVAL_MS} while the
 *    stream is down. In snapshot mode the same indicator reports a stale feed
 *    after `SNAPSHOT_STALE_AFTER_FAILURES` consecutive failed polls.
 *
 * Tap / hold / double-tap live in `actions.ts`; the card only attaches the
 * {@link ActionController} to its container and renders the matching
 * accessibility affordances.
 *
 * The card never talks to a player or a socket directly: it reports facts and
 * renders state. Everything about *when to reconnect* lives in
 * `reliability/supervisor.ts`.
 */

import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { state } from 'lit/decorators.js';
import { ActionController, isInteractive } from './actions';
import { buildConfigForm, type ConfigForm } from './editor';
import { endpointResolver } from './endpoint';
import { MsePlayer } from './player/mse-player';
import { StreamSupervisorImpl, type StreamSupervisorDeps } from './reliability/supervisor';
import { SnapshotLoop } from './snapshot';
import {
  ACTION_NAMES,
  CARD_TAG,
  CARD_TYPE,
  CONFIG_DEFAULTS,
  LIVE_DURATION_MIN_S,
  OVERLAY_MODES,
  POSTER_REFRESH_INTERVAL_MS,
  VIEW_MODES,
  type ActionConfig,
  type ActionName,
  type EndpointResolver,
  type HomeAssistant,
  type LivePlayer,
  type NormalizedCardConfig,
  type OverlayMode,
  type SupervisorState,
  type SupervisorStateDetail,
  type ViewMode,
} from './types';

const LOG_PREFIX = '[simpler-camera-card]';

/* -------------------------------------------------------------------------- */
/* Config validation                                                           */
/* -------------------------------------------------------------------------- */

/** Thrown by {@link normalizeConfig}; Lovelace renders `message` to the user. */
class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** HA entity ids are `<domain>.<object_id>`, lowercase alphanumeric + `_`. */
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

/** `"16:9"`, `"16/9"`, `"1.78"` — with optional surrounding whitespace. */
const ASPECT_RATIO_RE = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quoteList(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(', ');
}

/**
 * Validate one of the three action slots.
 *
 * Only `action` itself is checked; the remaining fields are handed to Home
 * Assistant verbatim, so validating them here would only make the card stale
 * as HA gains options.
 */
function validateAction(value: unknown, key: string, fallback: ActionConfig): ActionConfig {
  if (value === undefined) return fallback;
  if (!isPlainObject(value)) {
    throw new ConfigError(`"${key}" must be an action object, e.g. { action: more-info }.`);
  }
  const action = value.action;
  if (typeof action !== 'string' || !ACTION_NAMES.includes(action as ActionName)) {
    throw new ConfigError(
      `"${key}.action" must be one of ${quoteList(ACTION_NAMES)} (got ${JSON.stringify(action)}).`,
    );
  }
  return value as ActionConfig;
}

/** Normalize `aspect_ratio` to a CSS `aspect-ratio` value such as `"16 / 9"`. */
function validateAspectRatio(value: unknown): string {
  if (value === undefined) return CONFIG_DEFAULTS.aspectRatio;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ConfigError(`"aspect_ratio" must be a positive number (got ${value}).`);
    }
    return String(value);
  }

  if (typeof value === 'string') {
    const match = ASPECT_RATIO_RE.exec(value);
    if (match) {
      const [, width, height] = match;
      if (Number(width) > 0 && Number(height) > 0) return `${width} / ${height}`;
    } else {
      const asNumber = Number(value.trim());
      if (Number.isFinite(asNumber) && asNumber > 0) return String(asNumber);
    }
  }

  throw new ConfigError(
    `"aspect_ratio" must look like "16:9" or be a positive number ` +
      `(got ${JSON.stringify(value)}).`,
  );
}

/**
 * Validate a raw Lovelace config and apply every default.
 *
 * Unknown keys are deliberately **ignored** rather than rejected: Lovelace
 * injects its own (`view_layout`, `grid_options`, `visibility`, ...) and
 * third-party tooling adds more, so strict rejection would break valid
 * dashboards.
 *
 * Exported for tests and for the (future) config editor.
 *
 * @throws {ConfigError} with a message written for a human editing YAML
 */
export function normalizeConfig(raw: unknown): NormalizedCardConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError('Invalid configuration: expected a YAML mapping.');
  }

  const camera = raw.camera;
  if (camera === undefined || camera === null || camera === '') {
    throw new ConfigError('"camera" is required, e.g. camera: camera.front_yard.');
  }
  if (typeof camera !== 'string' || !ENTITY_ID_RE.test(camera)) {
    throw new ConfigError(
      `"camera" must be an entity id like "camera.front_yard" (got ${JSON.stringify(camera)}).`,
    );
  }
  if (!camera.startsWith('camera.')) {
    throw new ConfigError(`"camera" must be a camera entity (got "${camera}").`);
  }

  if (raw.stream !== undefined && (typeof raw.stream !== 'string' || raw.stream.trim() === '')) {
    throw new ConfigError(
      `"stream" must be a non-empty go2rtc stream name, e.g. front_yard_sub ` +
        `(got ${JSON.stringify(raw.stream)}).`,
    );
  }

  const overlay = raw.overlay ?? CONFIG_DEFAULTS.overlay;
  if (typeof overlay !== 'string' || !OVERLAY_MODES.includes(overlay as OverlayMode)) {
    throw new ConfigError(
      `"overlay" must be one of ${quoteList(OVERLAY_MODES)} (got ${JSON.stringify(raw.overlay)}).`,
    );
  }

  if (raw.overlay_text !== undefined && typeof raw.overlay_text !== 'string') {
    throw new ConfigError('"overlay_text" must be a string.');
  }
  if (overlay === 'custom' && (raw.overlay_text === undefined || raw.overlay_text === '')) {
    throw new ConfigError('"overlay: custom" requires "overlay_text" to be set.');
  }

  const mode = raw.mode ?? CONFIG_DEFAULTS.mode;
  if (typeof mode !== 'string' || !VIEW_MODES.includes(mode as ViewMode)) {
    throw new ConfigError(
      `"mode" must be one of ${quoteList(VIEW_MODES)} (got ${JSON.stringify(raw.mode)}).`,
    );
  }

  const refreshInterval = raw.refresh_interval ?? CONFIG_DEFAULTS.refreshInterval;
  if (
    typeof refreshInterval !== 'number' ||
    !Number.isFinite(refreshInterval) ||
    refreshInterval < 1
  ) {
    throw new ConfigError(
      `"refresh_interval" must be a number of seconds >= 1 ` +
        `(got ${JSON.stringify(raw.refresh_interval)}).`,
    );
  }

  const reloadAfter = raw.reload_after_minutes_down ?? CONFIG_DEFAULTS.reloadAfterMinutesDown;
  if (typeof reloadAfter !== 'number' || !Number.isFinite(reloadAfter) || reloadAfter < 0) {
    throw new ConfigError(
      `"reload_after_minutes_down" must be a number of minutes >= 0, or 0 to disable ` +
        `(got ${JSON.stringify(raw.reload_after_minutes_down)}).`,
    );
  }

  const tapToLive = raw.tap_to_live ?? CONFIG_DEFAULTS.tapToLive;
  if (typeof tapToLive !== 'boolean') {
    throw new ConfigError(
      `"tap_to_live" must be a boolean (got ${JSON.stringify(raw.tap_to_live)}).`,
    );
  }

  const liveDuration = raw.live_duration ?? CONFIG_DEFAULTS.liveDuration;
  if (
    typeof liveDuration !== 'number' ||
    !Number.isFinite(liveDuration) ||
    liveDuration < LIVE_DURATION_MIN_S
  ) {
    throw new ConfigError(
      `"live_duration" must be a number of seconds >= ${LIVE_DURATION_MIN_S} ` +
        `(got ${JSON.stringify(raw.live_duration)}).`,
    );
  }

  return {
    ...raw,
    type: typeof raw.type === 'string' ? raw.type : CARD_TYPE,
    camera,
    overlay: overlay as OverlayMode,
    tap_action: validateAction(raw.tap_action, 'tap_action', CONFIG_DEFAULTS.tapAction),
    hold_action: validateAction(raw.hold_action, 'hold_action', CONFIG_DEFAULTS.holdAction),
    double_tap_action: validateAction(
      raw.double_tap_action,
      'double_tap_action',
      CONFIG_DEFAULTS.doubleTapAction,
    ),
    aspect_ratio: validateAspectRatio(raw.aspect_ratio),
    reload_after_minutes_down: reloadAfter,
    mode: mode as ViewMode,
    refresh_interval: refreshInterval,
    tap_to_live: tapToLive,
    live_duration: liveDuration,
  };
}

/* -------------------------------------------------------------------------- */
/* The element                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the one `<video>` element the card ever owns.
 *
 * It is created imperatively and rendered as a *node value* in the template
 * (`${this._video}`) rather than as template markup. Lit renders a `Node` child
 * by inserting that exact node and leaves it alone on subsequent renders, so
 * the element the supervisor's `getVideo()` returns is guaranteed to be the
 * same one that is mounted — no re-created element can strand a `MediaSource`
 * on an orphan node, and no querySelector timing can return `null`.
 */
function createVideoElement(): HTMLVideoElement {
  const video = document.createElement('video');
  video.className = 'video';
  // Muted + playsinline is what satisfies autoplay policy; v1 has no audio.
  video.muted = true;
  for (const attribute of ['muted', 'playsinline', 'autoplay', 'disablepictureinpicture']) {
    video.setAttribute(attribute, '');
  }
  return video;
}

export class SimplerCameraCard extends LitElement {
  /**
   * Wiring overrides, for tests only.
   *
   * Production code never sets this: the card builds the supervisor from the
   * real endpoint resolver and the real player factory. Tests (unit and the
   * go2rtc integration rig) assign it *before* the element is connected to
   * point `endpoint` at a stub resolver — which is how the integration harness
   * injects a bare go2rtc URL without an HA instance, and without touching the
   * frozen contract in `types.ts`.
   */
  supervisorOverrides?: Partial<StreamSupervisorDeps>;

  /** Normalized config; `undefined` until Lovelace calls `setConfig`. */
  @state() private _config?: NormalizedCardConfig;

  /** Latest supervisor state, mirrored for rendering. */
  @state() private _streamState: SupervisorState = 'idle';

  /** Detail from the latest state change (retry delay, endpoint error, …). */
  @state() private _streamDetail?: SupervisorStateDetail;

  /** Latest poster URL, when one has been resolved. */
  @state() private _posterUrl?: string;

  /** Snapshot mode: the newest *decoded* frame. Undefined until the first one. */
  @state() private _snapshotUrl?: string;

  /** Snapshot mode: enough consecutive polls have failed to say so. */
  @state() private _snapshotStale = false;

  /** Snapshot mode: the last config-class endpoint failure, for the status pill. */
  @state() private _snapshotError?: string;

  /**
   * `tap_to_live`: a tap has put this snapshot card into its temporary live
   * window. While set, the card's *effective* mode is `live` — see
   * {@link _effectiveMode} — so the supervisor stack runs instead of the
   * snapshot loop.
   */
  @state() private _temporaryLive = false;

  /** Milliseconds left in the temporary live window; drives the LIVE pill. */
  @state() private _liveRemainingMs = 0;

  private _hass?: HomeAssistant;

  /** The stable media element; see {@link createVideoElement}. Live mode only. */
  private readonly _video: HTMLVideoElement = createVideoElement();

  /** Live mode: built on first connect with config + hass; destroyed on disconnect. */
  private _supervisor?: StreamSupervisorImpl;

  /** Snapshot mode: built and destroyed on exactly the same occasions. */
  private _snapshot?: SnapshotLoop;

  /**
   * Gesture recognizer for `tap_action` / `hold_action` / `double_tap_action`.
   *
   * It reads `_config` through a getter rather than being handed a snapshot, so
   * a Lovelace config edit changes behaviour without re-attaching listeners.
   * `hass-action` is dispatched from the host element (`this`), not the inner
   * container, so it leaves the shadow root from the node Lovelace knows.
   */
  private readonly _actions = new ActionController({
    getConfig: () => this._config,
    getEventTarget: () => this,
    onTap: () => this._onTapGesture(),
  });

  /** Resolver actually in use — the real one unless a test overrode it. */
  private get _endpoint(): EndpointResolver {
    return this.supervisorOverrides?.endpoint ?? endpointResolver;
  }

  /** Poster refresh interval handle, live only while the stream is down. */
  private _posterTimer?: ReturnType<typeof setInterval>;

  /** Fires once, at the end of the temporary live window. */
  private _liveWindowTimer?: ReturnType<typeof setTimeout>;

  /** 1 Hz tick that counts {@link _liveRemainingMs} down for the LIVE pill. */
  private _liveTickTimer?: ReturnType<typeof setInterval>;

  /** Guards against two pending `updateComplete` starts racing each other. */
  private _startScheduled = false;

  /**
   * Home Assistant assigns a *new* `hass` object on every state change in the
   * whole system, so re-rendering unconditionally would repaint constantly on a
   * busy instance. Only the camera entity and the connection flag matter here.
   */
  set hass(hass: HomeAssistant | undefined) {
    const previous = this._hass;
    this._hass = hass;

    // Trigger (d): the HA websocket came back. Anything that broke while it was
    // down (a rotated signing key, most importantly) is worth retrying now
    // rather than at the end of a backoff.
    if (previous?.connected === false && hass?.connected === true) {
      this._supervisor?.notifyExternalEvent('hass-reconnected');
      this._snapshot?.refreshNow();
    }

    this._maybeStart();
    if (!this._config) return;

    const before = previous?.states?.[this._config.camera];
    const after = hass?.states?.[this._config.camera];
    if (before !== after || previous?.connected !== hass?.connected) {
      this.requestUpdate('hass', previous);
    }
  }

  get hass(): HomeAssistant | undefined {
    return this._hass;
  }

  /** Called by Lovelace on every config edit; must throw on invalid input. */
  setConfig(config: unknown): void {
    const next = normalizeConfig(config);
    const previous = this._config;
    this._config = next;

    // A config edit changes the camera, stream, mode or escape-hatch policy, so
    // whatever is running is stale: tear it down and build a fresh one.
    if (previous) {
      this._stopEverything();
      this._posterUrl = undefined;
      this._snapshotUrl = undefined;
    }
    this._maybeStart();
  }

  /* ------------------------------------------------------------------ */
  /* Element lifecycle                                                   */
  /* ------------------------------------------------------------------ */

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    // Page Lifecycle: a frozen tab is resumed. Chromium fires `resume` on the
    // document; `pageshow` covers bfcache restores everywhere; `online` covers
    // a network that came back under a tab that never froze.
    document.addEventListener('resume', this._onPageResumed);
    window.addEventListener('pageshow', this._onPageResumed);
    window.addEventListener('online', this._onPageResumed);
    // `updated()` covers every render, but a card that is removed and re-added
    // without any property change never renders again — so re-attach here too.
    void this.updateComplete.then(() => {
      if (this.isConnected) this._syncActionTarget();
    });
    this._maybeStart();
  }

  disconnectedCallback(): void {
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    document.removeEventListener('resume', this._onPageResumed);
    window.removeEventListener('pageshow', this._onPageResumed);
    window.removeEventListener('online', this._onPageResumed);
    this._actions.detach();
    this._stopEverything();
    super.disconnectedCallback();
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    this._syncActionTarget();
  }

  /**
   * Keep the gesture recognizer bound to the live `.container` node. The node is
   * stable in practice (Lit reuses it), so this is normally a no-op; it exists
   * so nothing silently loses its listeners if the template ever changes shape.
   */
  private _syncActionTarget(): void {
    const container = this.shadowRoot?.querySelector<HTMLElement>('.container') ?? null;
    if (container === this._actions.target) return;
    if (container) this._actions.attach(container);
    else this._actions.detach();
  }

  private readonly _onVisibilityChange = (): void => {
    const hidden = document.visibilityState === 'hidden';
    // A live window nobody is looking at is not worth keeping: the card goes
    // back to being a snapshot card, and stays one when the tab returns. The
    // fresh loop starts paused (see `_startSnapshotLoop`).
    if (hidden && this._temporaryLive) {
      this._revertToSnapshots();
      return;
    }
    // Pausing a poll loop is free (no socket, no decoder), so snapshot mode
    // needs none of the supervisor's teardown grace period.
    if (hidden) this._snapshot?.pause();
    else this._snapshot?.resume();
    this._supervisor?.notifyExternalEvent(hidden ? 'visibility-hidden' : 'visibility-visible');
  };

  private readonly _onPageResumed = (): void => {
    this._snapshot?.resume();
    this._supervisor?.notifyExternalEvent('page-resumed');
  };

  /* ------------------------------------------------------------------ */
  /* Supervisor / snapshot-loop wiring                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Start showing the camera once the three preconditions hold: the element is
   * in the document, Lovelace has given us a config, and `hass` has arrived.
   * They can arrive in any order, so every one of those three events calls this.
   *
   * The start is deferred to `updateComplete` so the `<video>` is actually in
   * the document before a `MediaSource` is attached to it.
   *
   * The {@link _effectiveMode} picks exactly one of the two engines: a live card
   * never builds a {@link SnapshotLoop}, and a snapshot card never builds a
   * supervisor, a player or a watchdog — except inside a `tap_to_live` window,
   * which is precisely a snapshot card temporarily running the live engine.
   *
   * The mode is read inside the deferred callback, not before it, so a toggle
   * that lands while a start is already scheduled still gets the right engine.
   */
  private _maybeStart(): void {
    if (this._supervisor || this._snapshot || this._startScheduled) return;
    if (!this.isConnected || !this._config || !this._hass) return;

    this._startScheduled = true;
    void this.updateComplete.then(() => {
      this._startScheduled = false;
      if (this._supervisor || this._snapshot) return;
      if (!this.isConnected || !this._config || !this._hass) return;
      if (this._effectiveMode === 'snapshot') this._startSnapshotLoop(this._config);
      else this._startSupervisor(this._config);
    });
  }

  /**
   * The mode the card is *behaving* as right now.
   *
   * Identical to `config.mode` except inside a `tap_to_live` window, where a
   * snapshot card runs the live engine. Every runtime and render branch reads
   * this rather than `config.mode`; a `mode: live` card never consults
   * `tap_to_live` at all.
   */
  private get _effectiveMode(): ViewMode {
    const config = this._config;
    if (!config) return CONFIG_DEFAULTS.mode;
    return config.mode === 'snapshot' && this._temporaryLive ? 'live' : config.mode;
  }

  private _startSupervisor(config: NormalizedCardConfig): void {
    const supervisor = new StreamSupervisorImpl({
      createPlayer: (): LivePlayer => new MsePlayer(),
      endpoint: endpointResolver,
      getHass: () => this._hass,
      getVideo: () => this._video,
      getConfig: () => this._config ?? config,
      ...this.supervisorOverrides,
    });
    supervisor.onStateChange = (state, detail) => this._onStreamState(state, detail);
    this._supervisor = supervisor;
    supervisor.start();
  }

  private _stopSupervisor(): void {
    this._supervisor?.stop();
    this._supervisor = undefined;
    this._stopPosterRefresh();
    this._streamState = 'idle';
    this._streamDetail = undefined;
  }

  /**
   * Snapshot mode: poll HA's signed snapshot on the configured interval.
   *
   * The loop is handed the same injectable resolver the supervisor uses, so the
   * test seam (`supervisorOverrides.endpoint`) covers both modes.
   */
  private _startSnapshotLoop(config: NormalizedCardConfig): void {
    const loop = new SnapshotLoop({
      endpoint: this._endpoint,
      getHass: () => this._hass,
      getConfig: () => this._config ?? config,
      onFrame: (url) => {
        // A frame that decoded proves the whole path works again.
        this._snapshotUrl = url;
        this._snapshotStale = false;
        this._snapshotError = undefined;
      },
      onStale: () => {
        this._snapshotStale = true;
      },
      onEndpointError: (error) => {
        this._snapshotError = describeError(error);
      },
    });
    this._snapshot = loop;
    loop.start();
    // A loop built while the dashboard is hidden must not keep polling — the
    // ordinary case when a `tap_to_live` window is reverted *by* the tab being
    // hidden, since the loop is constructed after that event has been handled.
    // `start()`'s immediate poll is already in flight; pausing abandons it
    // (its frame is dropped) and cancels the interval, so a hidden dashboard
    // costs one signed URL and nothing after it.
    if (document.visibilityState === 'hidden') loop.pause();
  }

  private _stopSnapshotLoop(): void {
    this._snapshot?.destroy();
    this._snapshot = undefined;
    this._snapshotStale = false;
    this._snapshotError = undefined;
  }

  /**
   * Tear down whichever engine is running; safe when neither is.
   *
   * This is also the single place the temporary live window is cancelled, so
   * every existing teardown path (`setConfig`, `disconnectedCallback`) clears
   * its flag and both its timers without knowing the feature exists.
   */
  private _stopEverything(): void {
    this._clearLiveWindow();
    this._stopSupervisor();
    this._stopSnapshotLoop();
  }

  /* ------------------------------------------------------------------ */
  /* tap_to_live: the temporary live window                              */
  /* ------------------------------------------------------------------ */

  /**
   * The tap seam handed to {@link ActionController}.
   *
   * Returns `true` when the tap was consumed by the toggle — which is exactly
   * when the card is a snapshot card with `tap_to_live`. Every other card falls
   * through to the configured `tap_action`, unchanged.
   */
  private _onTapGesture(): boolean {
    const config = this._config;
    if (!config || config.mode !== 'snapshot' || !config.tap_to_live) return false;
    if (this._temporaryLive) this._revertToSnapshots();
    else this._goLive();
    return true;
  }

  /**
   * Swap the snapshot loop for the live stack and arm the window.
   *
   * `_snapshotUrl` is deliberately *not* cleared: it is what `render()` shows as
   * the (dimmed) poster while the stream connects, so the transition never
   * blanks. `_posterUrl`, by contrast, can only be left over from an earlier
   * window and would be stale, so it goes.
   */
  private _goLive(): void {
    const config = this._config;
    if (!config) return;
    this._stopEverything();
    this._temporaryLive = true;
    this._posterUrl = undefined;
    this._liveRemainingMs = Math.max(0, config.live_duration) * 1000;
    this._liveWindowTimer = setTimeout(() => {
      this._liveWindowTimer = undefined;
      this._revertToSnapshots();
    }, this._liveRemainingMs);
    // Countdown only; the window's end is the timer above, so a tick that
    // drifts can never cut the window short or extend it.
    this._liveTickTimer = setInterval(() => {
      this._liveRemainingMs = Math.max(0, this._liveRemainingMs - 1000);
    }, 1000);
    this._maybeStart();
  }

  /**
   * End the window: back to polling stills. The new loop's immediate first poll
   * is what refreshes the frame the live stream leaves behind.
   */
  private _revertToSnapshots(): void {
    if (!this._temporaryLive) return;
    this._stopEverything();
    this._maybeStart();
  }

  /** Cancel the window and its countdown. Safe when no window is running. */
  private _clearLiveWindow(): void {
    this._temporaryLive = false;
    this._liveRemainingMs = 0;
    if (this._liveWindowTimer !== undefined) {
      clearTimeout(this._liveWindowTimer);
      this._liveWindowTimer = undefined;
    }
    if (this._liveTickTimer !== undefined) {
      clearInterval(this._liveTickTimer);
      this._liveTickTimer = undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Degraded state: poster + status indicator                           */
  /* ------------------------------------------------------------------ */

  private _onStreamState(state: SupervisorState, detail?: SupervisorStateDetail): void {
    this._streamState = state;
    this._streamDetail = detail;

    if (state === 'playing') {
      // Live frames replace the poster entirely; stop paying for snapshots.
      this._stopPosterRefresh();
      return;
    }
    // `idle` here means stopped or suspended-while-hidden: keep whatever poster
    // we have on screen, but do not spend requests refreshing it.
    if (state === 'idle') {
      this._stopPosterRefresh();
      return;
    }
    void this._refreshPoster();
    this._startPosterRefresh();
  }

  private _startPosterRefresh(): void {
    if (this._posterTimer !== undefined) return;
    this._posterTimer = setInterval(() => {
      void this._refreshPoster();
    }, POSTER_REFRESH_INTERVAL_MS);
  }

  private _stopPosterRefresh(): void {
    if (this._posterTimer === undefined) return;
    clearInterval(this._posterTimer);
    this._posterTimer = undefined;
  }

  /**
   * Fetch a freshly signed snapshot URL.
   *
   * Failures are deliberately silent (an `info` line, nothing more): the poster
   * is decoration shown *because* something is already wrong, and a snapshot
   * that cannot be signed must never be the reason the card breaks.
   */
  private async _refreshPoster(): Promise<void> {
    const hass = this._hass;
    const config = this._config;
    if (!hass || !config) return;
    try {
      const url = await this._endpoint.resolvePosterUrl(hass, config);
      if (url) this._posterUrl = url;
    } catch (error) {
      console.info(`${LOG_PREFIX} poster refresh failed:`, error);
    }
  }

  /**
   * Masonry-view height, in ~50 px rows. A 16:9 video in a standard column is
   * roughly 275 px tall, plus a little slack — 6 rows.
   */
  getCardSize(): number {
    return 6;
  }

  /**
   * Sections-view sizing. Video needs width to be useful, so the card claims
   * the full 12-column section by default and refuses to be squeezed below
   * half-width.
   */
  static getGridOptions(): Record<string, number> {
    return {
      columns: 12,
      rows: 6,
      min_columns: 6,
      min_rows: 3,
    };
  }

  /** Card-picker default: the first Frigate camera we can find. */
  static getStubConfig(hass?: HomeAssistant): { type: string; camera: string } {
    const entities = Object.keys(hass?.states ?? {});
    const camera =
      entities.find(
        (id) => id.startsWith('camera.') && Boolean(hass?.states[id]?.attributes?.camera_name),
      ) ??
      entities.find((id) => id.startsWith('camera.')) ??
      'camera.front_yard';
    return { type: CARD_TYPE, camera };
  }

  /**
   * The visual editor. Home Assistant renders the form itself from the selector
   * schema in `editor.ts`; `normalizeConfig` is handed over as the fidelity
   * guard, so a config the form cannot represent throws and HA falls back to
   * the YAML editor rather than mangling it.
   */
  static getConfigForm(): ConfigForm {
    return buildConfigForm(normalizeConfig);
  }

  protected render(): TemplateResult | typeof nothing {
    const config = this._config;
    if (!config) return nothing;

    const snapshotMode = this._effectiveMode === 'snapshot';
    const entity = this._hass?.states?.[config.camera];
    // "We have something real to show": a playing stream, or a decoded frame.
    const showingMedia = snapshotMode
      ? this._snapshotUrl !== undefined
      : this._streamState === 'playing';
    // `entity_picture` is the unsigned fallback used until the first signed
    // snapshot resolves, so a fresh card is never a black rectangle. The last
    // decoded still sits between the two: inside a `tap_to_live` window it is
    // what keeps the card from blanking while the stream connects (in plain
    // snapshot mode a defined `_snapshotUrl` means `showingMedia`, so it never
    // reaches this expression).
    const poster = showingMedia
      ? undefined
      : (this._posterUrl ?? this._snapshotUrl ?? entity?.attributes?.entity_picture);
    // The one media layer: the stable `<video>` in live mode, a plain refreshing
    // `<img>` in snapshot mode (nothing external holds a reference to it, so it
    // needs none of the video element's node-value stability).
    const media = snapshotMode
      ? this._snapshotUrl !== undefined
        ? html`<img class="snapshot" src=${this._snapshotUrl} alt="" aria-hidden="true" />`
        : nothing
      : this._video;
    const overlayText = this._overlayText(config, entity?.attributes?.friendly_name);
    const status = snapshotMode
      ? this._snapshotStatusText(Boolean(entity))
      : this._temporaryLive && this._streamState === 'playing'
        ? // The one pill that is not a problem report: it says the window is
          // running, and for how much longer.
          `LIVE · ${Math.ceil(this._liveRemainingMs / 1000)}s`
        : showingMedia
          ? undefined
          : this._statusText(Boolean(entity));
    // Only a card whose *tap* does something is announced (and focusable) as a
    // button — see `isInteractive`.
    const interactive = isInteractive(config);
    const name = entity?.attributes?.friendly_name ?? config.camera;
    // On a tap-to-live card the tap is a toggle, so the label says which way it
    // goes rather than just naming the camera.
    const label =
      config.mode === 'snapshot' && config.tap_to_live
        ? `${name} — ${this._temporaryLive ? 'back to snapshots' : 'go live'}`
        : name;

    return html`
      <ha-card>
        <div
          class="container${interactive ? ' interactive' : ''}"
          style="aspect-ratio: ${config.aspect_ratio};"
          role=${interactive ? 'button' : nothing}
          tabindex=${interactive ? '0' : nothing}
          aria-label=${interactive ? label : nothing}
        >
          ${poster ? html`<img class="poster" src=${poster} alt="" aria-hidden="true" />` : nothing}
          ${media} ${overlayText ? html`<div class="overlay">${overlayText}</div>` : nothing}
          ${status ? html`<div class="status">${status}</div>` : nothing}
        </div>
      </ha-card>
    `;
  }

  private _overlayText(config: NormalizedCardConfig, friendlyName?: string): string | undefined {
    switch (config.overlay) {
      case 'name':
        return friendlyName ?? config.camera;
      case 'custom':
        return config.overlay_text;
      default:
        return undefined;
    }
  }

  /**
   * Status pill copy: the supervisor state, plus whatever detail makes the wait
   * comprehensible — how long until the next attempt, and why the last one
   * failed (endpoint/config errors arrive as `detail.message`).
   */
  private _statusText(entityExists: boolean): string | undefined {
    if (!this._hass) return 'Waiting for Home Assistant…';
    if (!entityExists) return `Entity ${this._config?.camera} not found`;

    const detail = this._streamDetail;
    switch (this._streamState) {
      case 'playing':
        return undefined;
      case 'connecting':
        return withMessage('Connecting…', detail?.message);
      case 'retrying':
      case 'remounting':
        return withMessage(`Reconnecting${formatDelay(detail?.delayMs)}…`, detail?.message);
      default:
        // `idle` is either "not started" or "paused while hidden"; the
        // supervisor says which in `detail.message`.
        return detail?.message ?? 'Not connected';
    }
  }

  /**
   * Status pill copy for `mode: snapshot`.
   *
   * Deliberately quiet: a single dropped poll says nothing at all (the last good
   * frame simply stays up), and only a config-class endpoint failure or a run of
   * failures long enough to matter puts text on screen.
   */
  private _snapshotStatusText(entityExists: boolean): string | undefined {
    if (!this._hass) return 'Waiting for Home Assistant…';
    if (!entityExists) return `Entity ${this._config?.camera} not found`;
    if (this._snapshotError) return withMessage('Snapshot unavailable', this._snapshotError);
    if (this._snapshotStale) return 'Snapshot is stale…';
    if (this._snapshotUrl === undefined) return 'Connecting…';
    return undefined;
  }

  static styles = css`
    :host {
      display: block;
    }

    ha-card {
      overflow: hidden;
      position: relative;
      height: 100%;
    }

    .container {
      position: relative;
      width: 100%;
      background: #000;
      /* aspect-ratio is set inline from config; 16 / 9 by default. */
    }

    /*
     * Only present when tap_action is not "none". touch-action: manipulation
     * drops the browser's own double-tap-to-zoom (and the ~300 ms click delay
     * that comes with it) without disabling the scroll that a dashboard needs;
     * disabling selection stops a hold from turning into a text/image selection
     * or an iOS callout on top of the gesture.
     */
    .container.interactive {
      cursor: pointer;
      touch-action: manipulation;
      -webkit-user-select: none;
      user-select: none;
    }

    /* The container is focusable when interactive, so it needs a focus ring. */
    .container.interactive:focus-visible {
      outline: 2px solid var(--primary-color, #03a9f4);
      outline-offset: -2px;
    }

    .poster,
    .snapshot,
    .video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      /*
       * The gesture surface is the container, full stop. Making the media layers
       * transparent to pointers keeps a press off the browser's own image/video
       * affordances (drag-to-save, media context menus) — the events would have
       * bubbled up anyway, but from a target we do not control.
       */
      pointer-events: none;
    }

    /*
     * Dimmed while the live view is not up, so a blip degrades gracefully. It
     * sits above the <video> deliberately: a dying stream can leave a frozen
     * frame on the element, and a stale live frame is more misleading than an
     * honestly dimmed snapshot. It is only rendered while not playing.
     */
    .poster {
      filter: brightness(0.6);
      z-index: 1;
    }

    .overlay {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 16px 8px 6px;
      color: #fff;
      font-size: 0.95em;
      font-weight: 500;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
      background: linear-gradient(to top, rgba(0, 0, 0, 0.55), transparent);
      pointer-events: none;
    }

    .status {
      position: absolute;
      z-index: 2;
      top: 8px;
      right: 8px;
      padding: 2px 8px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      font-size: 0.75em;
      line-height: 1.6;
      pointer-events: none;
    }
  `;
}

/** Best-effort human-readable text for anything that was thrown or rejected. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** `" in 8 s"` for a known delay, `""` otherwise. */
function formatDelay(delayMs?: number): string {
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs <= 0) return '';
  return delayMs < 1000 ? ' shortly' : ` in ${Math.round(delayMs / 1000)} s`;
}

/** Append the supervisor's human-readable detail, when there is one. */
function withMessage(text: string, message?: string): string {
  return message ? `${text} — ${message}` : text;
}

/* Guarded so a hot reload, or a test importing this module twice, is harmless. */
if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, SimplerCameraCard);
}

declare global {
  interface HTMLElementTagNameMap {
    'simpler-camera-card': SimplerCameraCard;
  }
}
