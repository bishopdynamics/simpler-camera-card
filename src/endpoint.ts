/**
 * `endpoint.ts` — URL construction and per-attempt signing.
 *
 * Everything the card connects to goes through Home Assistant's own HTTP
 * origin, so there is no CORS, no mixed content and no extra port to open:
 *
 * - live stream: `/api/frigate/<client_id>/go2rtc/ws/api/ws?src=<stream>`
 *   (frigate-hass-integration >= 5.12.0 proxy view)
 * - snapshot:    `/api/camera_proxy/<entity_id>`
 *
 * Both paths need an HA signature, obtained over the websocket with
 * `auth/sign_path`. **Signatures are minted per call and never cached** — a
 * cached signature is the single biggest reason the card this one replaces
 * never recovers from an HA restart (restart rotates the signing key), and a
 * camera snapshot's `access_token` rotates every ~5 minutes anyway.
 *
 * Implements {@link EndpointResolver}.
 */

import type {
  CameraEntity,
  EndpointErrorCode,
  EndpointResolver,
  HomeAssistant,
  SimplerCameraCardConfig,
} from './types';

/**
 * Signature lifetime, in seconds.
 *
 * Five minutes: long enough that a slow page load, a queued websocket command
 * or a sluggish handshake still connects, short enough that a URL leaking into
 * a log or a screenshot is quickly worthless. It is deliberately unrelated to
 * how long the stream runs — HA only checks the signature when the request is
 * made, and every reconnect attempt signs again.
 */
export const SIGNED_PATH_EXPIRY_SECONDS = 300;

/** Shape of the `auth/sign_path` websocket response. */
interface SignPathResponse {
  path: string;
}

/** A resolvable-endpoint failure, carrying a machine-readable code. */
export class EndpointError extends Error {
  readonly code: EndpointErrorCode;
  /** The underlying failure, when there was one. (`Error.cause` is ES2022; the
   * build targets ES2021, so it is assigned rather than passed to `super`.) */
  readonly cause?: unknown;

  constructor(code: EndpointErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'EndpointError';
    this.code = code;
    this.cause = options?.cause;
  }
}

/**
 * Last-known-good Frigate attributes, per camera entity id.
 *
 * When a camera stops feeding Frigate, frigate-hass-integration flips the
 * entity to `unavailable` and HA strips its attributes — including `client_id`
 * and `camera_name`, which say nothing about the physical camera and are still
 * perfectly valid for building the proxy path. go2rtc meanwhile keeps serving
 * the stream (Frigate substitutes its "No frames have been received" card), so
 * failing resolution here would turn a working stream into a permanent
 * "not a Frigate camera" retry loop. Falling back to the values from the last
 * successful resolution keeps reconnects working through the outage.
 *
 * Module-level on purpose: the attributes are properties of the entity, so the
 * cache is shared by every card instance and survives config edits.
 */
const lastKnownFrigateAttributes = new Map<
  string,
  { clientId: string; cameraName: string | undefined }
>();

/** Test hook: drop every cached attribute set. */
export function clearFrigateAttributeCache(): void {
  lastKnownFrigateAttributes.clear();
}

/** The value when it is a non-empty string, else `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Look up the configured camera entity.
 *
 * @throws {EndpointError} `entity-not-found` when it is absent from `hass.states`.
 */
export function getCameraEntity(hass: HomeAssistant, entityId: string): CameraEntity {
  const entity = hass.states?.[entityId];
  if (!entity) {
    throw new EndpointError(
      'entity-not-found',
      `Camera entity "${entityId}" was not found in Home Assistant. ` +
        `Check the entity id, and that the Frigate integration is loaded.`,
    );
  }
  return entity;
}

/**
 * Build the unsigned go2rtc websocket path for a camera.
 *
 * `client_id` (the Frigate config entry) always comes from the entity. The
 * stream name comes from `config.stream` when set — this is how sub-streams
 * (`<camera>_sub`) are selected, since HA exposes no stream selector — and
 * otherwise from the entity's `camera_name`.
 *
 * An entity whose attributes are stripped (HA does this while it is
 * `unavailable`) resolves from {@link lastKnownFrigateAttributes} instead, so a
 * camera outage at the Frigate end never breaks the go2rtc path. Only an entity
 * that has *never* resolved fails — with a message that blames the entity's
 * availability, not the integration version, when `unavailable` is the reason.
 *
 * @throws {EndpointError} `entity-not-found`, `missing-client-id`, `missing-stream-name`
 */
export function buildGo2rtcWsPath(hass: HomeAssistant, config: SimplerCameraCardConfig): string {
  const entity = getCameraEntity(hass, config.camera);
  const cached = lastKnownFrigateAttributes.get(config.camera);

  const liveClientId = nonEmptyString(entity.attributes?.client_id);
  const liveCameraName = nonEmptyString(entity.attributes?.camera_name);
  if (liveClientId !== undefined) {
    lastKnownFrigateAttributes.set(config.camera, {
      clientId: liveClientId,
      cameraName: liveCameraName,
    });
  }

  const clientId = liveClientId ?? cached?.clientId;
  if (clientId === undefined) {
    if (entity.state === 'unavailable') {
      throw new EndpointError(
        'missing-client-id',
        `Camera entity "${config.camera}" is currently unavailable in Home Assistant.`,
      );
    }
    throw new EndpointError(
      'missing-client-id',
      `Camera entity "${config.camera}" has no "client_id" attribute, so it is ` +
        `not a Frigate camera provided by frigate-hass-integration >= 5.12.0.`,
    );
  }

  const stream = nonEmptyString(config.stream) ?? liveCameraName ?? cached?.cameraName;
  if (stream === undefined) {
    throw new EndpointError(
      'missing-stream-name',
      `Camera entity "${config.camera}" has no "camera_name" attribute. ` +
        `Set "stream:" in the card config to name the go2rtc stream explicitly.`,
    );
  }

  return (
    `/api/frigate/${encodeURIComponent(clientId)}/go2rtc/ws/api/ws` +
    `?src=${encodeURIComponent(stream)}`
  );
}

/** The unsigned snapshot path for a camera entity. */
export function buildCameraProxyPath(entityId: string): string {
  return `/api/camera_proxy/${encodeURIComponent(entityId)}`;
}

/**
 * Sign a path with Home Assistant, returning the signed path (still relative).
 *
 * Called once per connection attempt — the result is intentionally never
 * memoised anywhere in this module.
 *
 * @throws {EndpointError} `sign-failed`
 */
export async function signPath(
  hass: HomeAssistant,
  path: string,
  expires: number = SIGNED_PATH_EXPIRY_SECONDS,
): Promise<string> {
  let response: SignPathResponse;
  try {
    response = await hass.callWS<SignPathResponse>({
      type: 'auth/sign_path',
      path,
      expires,
    });
  } catch (cause) {
    throw new EndpointError(
      'sign-failed',
      `Home Assistant refused to sign "${path}": ${describeError(cause)}`,
      { cause },
    );
  }

  if (!response || typeof response.path !== 'string' || response.path === '') {
    throw new EndpointError('sign-failed', `Home Assistant returned no signed path for "${path}".`);
  }
  return response.path;
}

/**
 * Turn a (signed) same-origin path into an absolute `ws://` / `wss://` URL.
 *
 * The card is always served by HA itself, so the page origin is the right
 * authority; `https:` maps to `wss:` so a TLS dashboard never opens a plaintext
 * socket.
 */
export function toAbsoluteWsUrl(path: string, base: Location | URL = location): string {
  const url = new URL(path, base.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** Turn a (signed) same-origin path into an absolute `http(s)://` URL. */
export function toAbsoluteHttpUrl(path: string, base: Location | URL = location): string {
  return new URL(path, base.href).toString();
}

/**
 * Signed, absolute go2rtc websocket URL for this attempt.
 *
 * @throws {EndpointError}
 */
export async function resolveSignedWsUrl(
  hass: HomeAssistant,
  config: SimplerCameraCardConfig,
): Promise<string> {
  const path = buildGo2rtcWsPath(hass, config);
  const signed = await signPath(hass, path);
  return toAbsoluteWsUrl(signed);
}

/**
 * Signed, absolute snapshot URL, or `null` when the camera entity is missing.
 *
 * A missing entity is not an error here: the poster is decoration, and the
 * stream path already reports the problem loudly.
 *
 * @throws {EndpointError} `sign-failed`
 */
export async function resolvePosterUrl(
  hass: HomeAssistant,
  config: SimplerCameraCardConfig,
): Promise<string | null> {
  if (!hass.states?.[config.camera]) {
    return null;
  }
  const signed = await signPath(hass, buildCameraProxyPath(config.camera));
  return toAbsoluteHttpUrl(signed);
}

/** The default {@link EndpointResolver}; injectable so tests can substitute one. */
export const endpointResolver: EndpointResolver = {
  resolveSignedWsUrl,
  resolvePosterUrl,
};

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  if (cause && typeof cause === 'object' && 'message' in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
}
