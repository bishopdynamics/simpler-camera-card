/**
 * `card.ts` — the `simpler-camera-card` custom element.
 *
 * The card owns three things and delegates everything else:
 *
 * 1. **Config** — validation, defaults and the errors Lovelace shows the user.
 * 2. **Wiring** — it builds the one {@link StreamSupervisorImpl} that owns the
 *    connection state machine, hands it the real {@link endpointResolver}, a
 *    {@link PlayerFactory} and getters for `hass` / `<video>` / config, then
 *    reports page-lifecycle facts to it (`visibilitychange`, `pageshow`,
 *    `online`, `resume`, and the `hass.connected` false→true edge).
 * 3. **Degraded UX** — while the stream is not `playing` it shows the latest
 *    camera snapshot, dimmed, with a small status indicator; the snapshot is
 *    re-signed and refreshed every {@link POSTER_REFRESH_INTERVAL_MS} while the
 *    stream is down.
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
import { endpointResolver } from './endpoint';
import { MsePlayer } from './player/mse-player';
import { StreamSupervisorImpl, type StreamSupervisorDeps } from './reliability/supervisor';
import {
  ACTION_NAMES,
  CARD_TAG,
  CARD_TYPE,
  CONFIG_DEFAULTS,
  OVERLAY_MODES,
  POSTER_REFRESH_INTERVAL_MS,
  TRANSPORTS,
  type ActionConfig,
  type ActionName,
  type EndpointResolver,
  type HomeAssistant,
  type LivePlayer,
  type NormalizedCardConfig,
  type OverlayMode,
  type SupervisorState,
  type SupervisorStateDetail,
  type Transport,
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

  const transport = raw.transport ?? CONFIG_DEFAULTS.transport;
  if (typeof transport !== 'string' || !TRANSPORTS.includes(transport as Transport)) {
    throw new ConfigError(
      `"transport" must be one of ${quoteList(TRANSPORTS)} (got ${JSON.stringify(raw.transport)}).`,
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

  const reloadAfter = raw.reload_after_minutes_down ?? CONFIG_DEFAULTS.reloadAfterMinutesDown;
  if (typeof reloadAfter !== 'number' || !Number.isFinite(reloadAfter) || reloadAfter < 0) {
    throw new ConfigError(
      `"reload_after_minutes_down" must be a number of minutes >= 0, or 0 to disable ` +
        `(got ${JSON.stringify(raw.reload_after_minutes_down)}).`,
    );
  }

  return {
    ...raw,
    type: typeof raw.type === 'string' ? raw.type : CARD_TYPE,
    camera,
    transport: transport as Transport,
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

  private _hass?: HomeAssistant;

  /** The stable media element; see {@link createVideoElement}. */
  private readonly _video: HTMLVideoElement = createVideoElement();

  /** Built on first connect with config + hass; destroyed on disconnect. */
  private _supervisor?: StreamSupervisorImpl;

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
  });

  /** Resolver actually in use — the real one unless a test overrode it. */
  private get _endpoint(): EndpointResolver {
    return this.supervisorOverrides?.endpoint ?? endpointResolver;
  }

  /** Poster refresh interval handle, live only while the stream is down. */
  private _posterTimer?: ReturnType<typeof setInterval>;

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

    // TODO(slice 7): delete this once `player/webrtc-player.ts` exists. The
    // schema accepts `webrtc` (it is part of the frozen config contract), but
    // accepting it here would leave the user staring at a card that retries
    // forever with no explanation.
    if (next.transport === 'webrtc') {
      throw new ConfigError(
        '"transport: webrtc" is coming soon — this version only supports "transport: mse".',
      );
    }

    const previous = this._config;
    this._config = next;

    // A config edit changes the camera, stream or escape-hatch policy, so the
    // running supervisor is stale: tear it down and build a fresh one.
    if (previous) {
      this._stopSupervisor();
      this._posterUrl = undefined;
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
    this._stopSupervisor();
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
    this._supervisor?.notifyExternalEvent(
      document.visibilityState === 'hidden' ? 'visibility-hidden' : 'visibility-visible',
    );
  };

  private readonly _onPageResumed = (): void => {
    this._supervisor?.notifyExternalEvent('page-resumed');
  };

  /* ------------------------------------------------------------------ */
  /* Supervisor wiring                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Start streaming once the three preconditions hold: the element is in the
   * document, Lovelace has given us a config, and `hass` has arrived. They can
   * arrive in any order, so every one of those three events calls this.
   *
   * The start is deferred to `updateComplete` so the `<video>` is actually in
   * the document before a `MediaSource` is attached to it.
   */
  private _maybeStart(): void {
    if (this._supervisor || this._startScheduled) return;
    if (!this.isConnected || !this._config || !this._hass) return;

    this._startScheduled = true;
    void this.updateComplete.then(() => {
      this._startScheduled = false;
      if (this._supervisor || !this.isConnected || !this._config || !this._hass) return;
      this._startSupervisor(this._config);
    });
  }

  private _startSupervisor(config: NormalizedCardConfig): void {
    const supervisor = new StreamSupervisorImpl({
      createPlayer: (transport): LivePlayer => {
        if (transport === 'webrtc') {
          // Unreachable through `setConfig` today; slice 7 replaces this arm
          // with `new WebRtcPlayer()`.
          throw new Error('transport "webrtc" is not implemented yet');
        }
        return new MsePlayer();
      },
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

  protected render(): TemplateResult | typeof nothing {
    const config = this._config;
    if (!config) return nothing;

    const live = this._streamState === 'playing';
    const entity = this._hass?.states?.[config.camera];
    // `entity_picture` is the unsigned fallback used until the first signed
    // snapshot resolves, so a fresh card is never a black rectangle.
    const poster = live ? undefined : (this._posterUrl ?? entity?.attributes?.entity_picture);
    const overlayText = this._overlayText(config, entity?.attributes?.friendly_name);
    const status = live ? undefined : this._statusText(Boolean(entity));
    // Only a card whose *tap* does something is announced (and focusable) as a
    // button — see `isInteractive`.
    const interactive = isInteractive(config);
    const label = entity?.attributes?.friendly_name ?? config.camera;

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
          ${this._video} ${overlayText ? html`<div class="overlay">${overlayText}</div>` : nothing}
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
