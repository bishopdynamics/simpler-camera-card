/**
 * `card.ts` — the `simpler-camera-card` custom element.
 *
 * This slice delivers the shell: config validation/normalization, the `hass`
 * accessor, and a render tree with the poster, video, overlay and status
 * layers already in place. The supervisor/player wiring that fills them lands
 * in a later slice; until then the card renders its "not connected"
 * placeholder state.
 */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { state } from 'lit/decorators.js';
import {
  ACTION_NAMES,
  CARD_TAG,
  CARD_TYPE,
  CONFIG_DEFAULTS,
  OVERLAY_MODES,
  TRANSPORTS,
  type ActionConfig,
  type ActionName,
  type HomeAssistant,
  type NormalizedCardConfig,
  type OverlayMode,
  type SupervisorState,
  type Transport,
} from './types';

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

export class SimplerCameraCard extends LitElement {
  /** Normalized config; `undefined` until Lovelace calls `setConfig`. */
  @state() private _config?: NormalizedCardConfig;

  /** Latest supervisor state. Nothing drives this yet (wiring is a later slice). */
  @state() private _streamState: SupervisorState = 'idle';

  /** Latest poster URL, when one has been resolved. */
  @state() private _posterUrl?: string;

  private _hass?: HomeAssistant;

  /**
   * Home Assistant assigns a *new* `hass` object on every state change in the
   * whole system, so re-rendering unconditionally would repaint constantly on a
   * busy instance. Only the camera entity and the connection flag matter here.
   */
  set hass(hass: HomeAssistant | undefined) {
    const previous = this._hass;
    this._hass = hass;
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
    this._config = normalizeConfig(config);
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

    const entity = this._hass?.states?.[config.camera];
    const poster = this._posterUrl ?? entity?.attributes?.entity_picture;
    const overlayText = this._overlayText(config, entity?.attributes?.friendly_name);
    const status = this._statusText(Boolean(entity));

    return html`
      <ha-card>
        <div class="container" style="aspect-ratio: ${config.aspect_ratio};">
          ${poster ? html`<img class="poster" src=${poster} alt="" aria-hidden="true" />` : nothing}
          <video class="video" muted playsinline autoplay disablepictureinpicture></video>
          ${overlayText ? html`<div class="overlay">${overlayText}</div>` : nothing}
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
   * Status pill copy. The stream is never started in this slice, so a
   * well-formed card reports the placeholder "not connected" state.
   */
  private _statusText(entityExists: boolean): string | undefined {
    if (!this._hass) return 'Waiting for Home Assistant…';
    if (!entityExists) return `Entity ${this._config?.camera} not found`;
    switch (this._streamState) {
      case 'playing':
        return undefined;
      case 'connecting':
        return 'Connecting…';
      case 'retrying':
        return 'Reconnecting…';
      case 'remounting':
        return 'Reconnecting…';
      default:
        return 'Not connected';
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

    .poster,
    .video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }

    /* Dimmed while the live view is not up, so a blip degrades gracefully. */
    .poster {
      filter: brightness(0.6);
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

/* Guarded so a hot reload, or a test importing this module twice, is harmless. */
if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, SimplerCameraCard);
}

declare global {
  interface HTMLElementTagNameMap {
    'simpler-camera-card': SimplerCameraCard;
  }
}
