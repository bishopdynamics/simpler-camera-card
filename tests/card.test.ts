import { describe, expect, it } from 'vitest';
import { SimplerCameraCard, normalizeConfig } from '../src/card';
import { CARD_TAG, CARD_TYPE, type CameraEntity, type HomeAssistant } from '../src/types';

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

  it('renders the shell: poster, video, overlay and status layers', async () => {
    const card = document.createElement(CARD_TAG);
    card.setConfig({ ...base, overlay: 'name' });
    card.hass = fakeHass(
      cameraEntity('camera.front_yard', {
        camera_name: 'front_yard',
        friendly_name: 'Front Yard',
        entity_picture: '/api/camera_proxy/camera.front_yard?token=abc',
      }),
    );
    document.body.appendChild(card);
    await card.updateComplete;

    const root = card.shadowRoot!;
    expect(root.querySelector('video')).not.toBeNull();
    expect(root.querySelector('img.poster')?.getAttribute('src')).toContain('/api/camera_proxy/');
    expect(root.querySelector('.overlay')?.textContent?.trim()).toBe('Front Yard');
    // Nothing drives the stream yet, so the placeholder state is shown.
    expect(root.querySelector('.status')?.textContent?.trim()).toBe('Not connected');
    expect(root.querySelector('.container')?.getAttribute('style')).toContain('16 / 9');

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
