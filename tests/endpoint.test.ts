import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EndpointError,
  SIGNED_PATH_EXPIRY_SECONDS,
  buildCameraProxyPath,
  buildGo2rtcWsPath,
  clearFrigateAttributeCache,
  endpointResolver,
  resolvePosterUrl,
  resolveSignedWsUrl,
  signPath,
  toAbsoluteWsUrl,
} from '../src/endpoint';
import type { CameraEntity, HomeAssistant, SimplerCameraCardConfig } from '../src/types';

// The last-known-attribute cache is module state; isolate every test from it.
beforeEach(() => {
  clearFrigateAttributeCache();
});

/** A Frigate camera entity as the integration actually exposes it. */
function cameraEntity(overrides: Partial<CameraEntity['attributes']> = {}): CameraEntity {
  return {
    entity_id: 'camera.front_yard',
    state: 'streaming',
    attributes: {
      client_id: 'frigate',
      camera_name: 'front_yard',
      friendly_name: 'Front Yard',
      ...overrides,
    },
  };
}

/** Minimal `hass` double whose `callWS` mimics HA's `auth/sign_path` handler. */
function fakeHass(entity: CameraEntity | null = cameraEntity()): HomeAssistant {
  let nonce = 0;
  const callWS = vi.fn(async (msg: Record<string, unknown>) => {
    if (msg.type !== 'auth/sign_path') throw new Error(`unexpected ws command ${msg.type}`);
    nonce += 1;
    const path = String(msg.path);
    const separator = path.includes('?') ? '&' : '?';
    return { path: `${path}${separator}authSig=sig-${nonce}` };
  });

  return {
    states: entity ? { [entity.entity_id]: entity } : {},
    connected: true,
    connection: {} as HomeAssistant['connection'],
    callWS: callWS as unknown as HomeAssistant['callWS'],
  };
}

const config: SimplerCameraCardConfig = {
  type: 'custom:simpler-camera-card',
  camera: 'camera.front_yard',
};

describe('buildGo2rtcWsPath', () => {
  it('builds the frigate proxy path from the entity attributes', () => {
    expect(buildGo2rtcWsPath(fakeHass(), config)).toBe(
      '/api/frigate/frigate/go2rtc/ws/api/ws?src=front_yard',
    );
  });

  it('lets config.stream override the default stream (sub-stream selection)', () => {
    expect(buildGo2rtcWsPath(fakeHass(), { ...config, stream: 'front_yard_sub' })).toBe(
      '/api/frigate/frigate/go2rtc/ws/api/ws?src=front_yard_sub',
    );
  });

  it('url-encodes the client id and stream name', () => {
    const hass = fakeHass(cameraEntity({ client_id: 'my frigate', camera_name: 'front/yard' }));
    expect(buildGo2rtcWsPath(hass, config)).toBe(
      '/api/frigate/my%20frigate/go2rtc/ws/api/ws?src=front%2Fyard',
    );
  });

  it('reports a missing entity', () => {
    expect(() => buildGo2rtcWsPath(fakeHass(null), config)).toThrowError(
      expect.objectContaining({ code: 'entity-not-found' }),
    );
  });

  it('reports an entity that is not a Frigate camera', () => {
    const hass = fakeHass(cameraEntity({ client_id: undefined }));
    expect(() => buildGo2rtcWsPath(hass, config)).toThrowError(
      expect.objectContaining({ code: 'missing-client-id' }),
    );
  });

  it('reports a camera with no stream name and no config override', () => {
    const hass = fakeHass(cameraEntity({ camera_name: undefined }));
    expect(() => buildGo2rtcWsPath(hass, config)).toThrowError(
      expect.objectContaining({ code: 'missing-stream-name' }),
    );
  });

  it('accepts a camera with no camera_name when stream is configured', () => {
    const hass = fakeHass(cameraEntity({ camera_name: undefined }));
    expect(buildGo2rtcWsPath(hass, { ...config, stream: 'explicit' })).toBe(
      '/api/frigate/frigate/go2rtc/ws/api/ws?src=explicit',
    );
  });

  describe('unavailable entities (attributes stripped by HA)', () => {
    /** The entity as HA presents it while unavailable: present, but bare. */
    function unavailableEntity(): CameraEntity {
      return {
        entity_id: 'camera.front_yard',
        state: 'unavailable',
        attributes: { friendly_name: 'Front Yard' },
      };
    }

    it('falls back to the attributes from the last successful resolution', () => {
      expect(buildGo2rtcWsPath(fakeHass(), config)).toBe(
        '/api/frigate/frigate/go2rtc/ws/api/ws?src=front_yard',
      );

      // Camera stops feeding Frigate: entity flips unavailable, attributes gone.
      expect(buildGo2rtcWsPath(fakeHass(unavailableEntity()), config)).toBe(
        '/api/frigate/frigate/go2rtc/ws/api/ws?src=front_yard',
      );
    });

    it('reports availability — not integration version — when nothing is cached', () => {
      expect(() => buildGo2rtcWsPath(fakeHass(unavailableEntity()), config)).toThrowError(
        expect.objectContaining({
          code: 'missing-client-id',
          message: expect.stringContaining('unavailable'),
        }),
      );
    });

    it('does not reuse a cache entry across entity ids', () => {
      buildGo2rtcWsPath(fakeHass(), config);

      const other = { ...unavailableEntity(), entity_id: 'camera.back_yard' };
      expect(() =>
        buildGo2rtcWsPath(fakeHass(other), { ...config, camera: 'camera.back_yard' }),
      ).toThrowError(expect.objectContaining({ code: 'missing-client-id' }));
    });

    it('keeps a cached attribute a later partial state does not carry', () => {
      // A full resolution primes the cache.
      buildGo2rtcWsPath(fakeHass(), config);

      // HA now delivers the entity with `client_id` but no `camera_name`. This
      // call still resolves — from the cache — and must not erase the cached
      // stream name on its way through.
      expect(buildGo2rtcWsPath(fakeHass(cameraEntity({ camera_name: undefined })), config)).toBe(
        '/api/frigate/frigate/go2rtc/ws/api/ws?src=front_yard',
      );

      // The proof: with the attributes stripped entirely there is nothing left
      // but the cache, and it still has to hold the last known good stream.
      expect(buildGo2rtcWsPath(fakeHass(unavailableEntity()), config)).toBe(
        '/api/frigate/frigate/go2rtc/ws/api/ws?src=front_yard',
      );
    });

    it('remembers a camera_name that arrived without a client_id', () => {
      buildGo2rtcWsPath(fakeHass(), config);

      // The mirror image: the cached `client_id` carries the call, and the
      // live `camera_name` is the fresh half.
      const renamed = fakeHass(cameraEntity({ client_id: undefined, camera_name: 'renamed' }));
      expect(buildGo2rtcWsPath(renamed, config)).toBe(
        '/api/frigate/frigate/go2rtc/ws/api/ws?src=renamed',
      );

      // Both halves of what resolved are now the last known good pair.
      expect(buildGo2rtcWsPath(fakeHass(unavailableEntity()), config)).toBe(
        '/api/frigate/frigate/go2rtc/ws/api/ws?src=renamed',
      );
    });

    it('prefers live attributes over the cache once the entity recovers', () => {
      buildGo2rtcWsPath(fakeHass(), config);
      const renamed = fakeHass(cameraEntity({ client_id: 'other', camera_name: 'renamed' }));
      expect(buildGo2rtcWsPath(renamed, config)).toBe(
        '/api/frigate/other/go2rtc/ws/api/ws?src=renamed',
      );
    });
  });

  it('still reports an available entity without client_id as not a Frigate camera', () => {
    const hass = fakeHass(cameraEntity({ client_id: undefined }));
    expect(() => buildGo2rtcWsPath(hass, config)).toThrowError(
      expect.objectContaining({
        code: 'missing-client-id',
        message: expect.stringContaining('frigate-hass-integration'),
      }),
    );
  });
});

describe('signPath', () => {
  it('calls auth/sign_path with a short expiry and returns the signed path', async () => {
    const hass = fakeHass();
    await expect(signPath(hass, '/api/thing')).resolves.toBe('/api/thing?authSig=sig-1');
    expect(hass.callWS).toHaveBeenCalledWith({
      type: 'auth/sign_path',
      path: '/api/thing',
      expires: SIGNED_PATH_EXPIRY_SECONDS,
    });
  });

  it('wraps a websocket failure as sign-failed', async () => {
    const hass = fakeHass();
    (hass.callWS as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('not authorized'));
    await expect(signPath(hass, '/api/thing')).rejects.toMatchObject({
      name: 'EndpointError',
      code: 'sign-failed',
    });
  });

  it('rejects an unusable response', async () => {
    const hass = fakeHass();
    (hass.callWS as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});
    await expect(signPath(hass, '/api/thing')).rejects.toBeInstanceOf(EndpointError);
  });
});

describe('toAbsoluteWsUrl', () => {
  it('maps http origins to ws://', () => {
    const base = new URL('http://ha.local:8123/lovelace/0');
    expect(toAbsoluteWsUrl('/api/x?authSig=abc', base)).toBe(
      'ws://ha.local:8123/api/x?authSig=abc',
    );
  });

  it('maps https origins to wss://', () => {
    const base = new URL('https://ha.example.com/lovelace/0');
    expect(toAbsoluteWsUrl('/api/x?authSig=abc', base)).toBe(
      'wss://ha.example.com/api/x?authSig=abc',
    );
  });
});

describe('resolveSignedWsUrl', () => {
  beforeEach(() => {
    // happy-dom serves the page from http://localhost:3000 by default.
    expect(location.origin).toMatch(/^https?:\/\//);
  });

  it('returns an absolute, signed websocket url', async () => {
    const hass = fakeHass();
    const url = await resolveSignedWsUrl(hass, config);
    expect(url).toBe(
      `${location.origin.replace(/^http/, 'ws')}` +
        '/api/frigate/frigate/go2rtc/ws/api/ws?src=front_yard&authSig=sig-1',
    );
  });

  it('signs again on every call and never reuses a signature', async () => {
    const hass = fakeHass();
    const first = await resolveSignedWsUrl(hass, config);
    const second = await resolveSignedWsUrl(hass, config);

    expect(hass.callWS).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(second);
    expect(first).toContain('authSig=sig-1');
    expect(second).toContain('authSig=sig-2');
  });

  it('rejects when the entity is missing, without calling the websocket', async () => {
    const hass = fakeHass(null);
    await expect(resolveSignedWsUrl(hass, config)).rejects.toMatchObject({
      code: 'entity-not-found',
    });
    expect(hass.callWS).not.toHaveBeenCalled();
  });
});

describe('resolvePosterUrl', () => {
  it('signs the camera_proxy path per call', async () => {
    const hass = fakeHass();
    const first = await resolvePosterUrl(hass, config);
    const second = await resolvePosterUrl(hass, config);

    expect(buildCameraProxyPath('camera.front_yard')).toBe('/api/camera_proxy/camera.front_yard');
    expect(hass.callWS).toHaveBeenNthCalledWith(1, {
      type: 'auth/sign_path',
      path: '/api/camera_proxy/camera.front_yard',
      expires: SIGNED_PATH_EXPIRY_SECONDS,
    });
    expect(first).toBe(`${location.origin}/api/camera_proxy/camera.front_yard?authSig=sig-1`);
    expect(second).toBe(`${location.origin}/api/camera_proxy/camera.front_yard?authSig=sig-2`);
  });

  it('returns null (not an error) when the entity is missing', async () => {
    const hass = fakeHass(null);
    await expect(resolvePosterUrl(hass, config)).resolves.toBeNull();
    expect(hass.callWS).not.toHaveBeenCalled();
  });
});

describe('endpointResolver', () => {
  it('implements the EndpointResolver contract', () => {
    expect(typeof endpointResolver.resolveSignedWsUrl).toBe('function');
    expect(typeof endpointResolver.resolvePosterUrl).toBe('function');
  });
});
