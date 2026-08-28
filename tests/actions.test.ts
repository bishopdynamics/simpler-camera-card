import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActionController,
  DOUBLE_TAP_MS,
  HOLD_MS,
  TAP_SLOP_PX,
  fireHassAction,
  hassActionConfig,
  isInteractive,
  resolveAction,
  type GestureAction,
  type HassActionDetail,
} from '../src/actions';
import { type ActionConfig, type NormalizedCardConfig } from '../src/types';
import {
  collectHassActions,
  fakeConfig as config,
  pointer,
  releaseHassActions,
  tap,
} from './fixtures';

interface Rig {
  target: HTMLElement;
  controller: ActionController;
  /** Every `hass-action` detail seen at the document, in order. */
  readonly fired: HassActionDetail[];
  /** Just the gesture names, which is what most assertions care about. */
  actions: () => GestureAction[];
  setConfig: (next: NormalizedCardConfig | null) => void;
}

let rigs: Rig[] = [];

/** `null` stands for "Lovelace has not called setConfig yet". */
function rig(initial: NormalizedCardConfig | null = config(), onTap?: () => boolean): Rig {
  const target = document.createElement('div');
  document.body.appendChild(target);

  let current = initial;
  const events = collectHassActions();

  const controller = new ActionController({ getConfig: () => current ?? undefined, onTap });
  controller.attach(target);

  const built: Rig = {
    target,
    controller,
    get fired(): HassActionDetail[] {
      return events.map((event) => event.detail);
    },
    actions: () => events.map((event) => event.detail.action),
    setConfig: (next) => {
      current = next;
    },
  };
  rigs.push(built);
  return built;
}

beforeEach(() => {
  rigs = [];
});

afterEach(() => {
  for (const built of rigs) {
    built.controller.detach();
    built.target.remove();
  }
  releaseHassActions();
  vi.useRealTimers();
});

describe('hass-action event shape', () => {
  it('carries the entity plus all three action slots', () => {
    const cfg = config({
      tap_action: { action: 'navigate', navigation_path: '/lovelace/cams' } as ActionConfig,
      hold_action: { action: 'more-info' } as ActionConfig,
    });
    expect(hassActionConfig(cfg)).toEqual({
      entity: 'camera.front_yard',
      tap_action: { action: 'navigate', navigation_path: '/lovelace/cams' },
      hold_action: { action: 'more-info' },
      double_tap_action: { action: 'none' },
    });
  });

  it('bubbles and composes out of a shadow root', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    root.appendChild(inner);

    const seen = collectHassActions();
    fireHassAction(inner, config(), 'tap');

    expect(seen).toHaveLength(1);
    expect(seen[0].bubbles).toBe(true);
    expect(seen[0].composed).toBe(true);
    expect(seen[0].detail).toEqual({
      config: hassActionConfig(config()),
      action: 'tap',
    });
    host.remove();
  });

  it('maps each gesture onto its config slot', () => {
    const cfg = config({
      hold_action: { action: 'toggle' } as ActionConfig,
      double_tap_action: { action: 'url', url_path: '/x' } as ActionConfig,
    });
    expect(resolveAction(cfg, 'tap').action).toBe('more-info');
    expect(resolveAction(cfg, 'hold').action).toBe('toggle');
    expect(resolveAction(cfg, 'double_tap').action).toBe('url');
  });

  it('treats only a real tap action as interactive', () => {
    expect(isInteractive(config())).toBe(true);
    expect(isInteractive(config({ tap_action: { action: 'none' } as ActionConfig }))).toBe(false);
    // A hold-only card is not a button: Enter could not activate it.
    expect(
      isInteractive(
        config({
          tap_action: { action: 'none' } as ActionConfig,
          hold_action: { action: 'more-info' } as ActionConfig,
        }),
      ),
    ).toBe(false);
  });

  it('counts a tap_to_live snapshot card as interactive whatever tap_action says', () => {
    const tapToLive = { mode: 'snapshot' as const, tap_to_live: true };
    expect(
      isInteractive(config({ ...tapToLive, tap_action: { action: 'none' } as ActionConfig })),
    ).toBe(true);
    // Under `mode: live` the option means nothing at all.
    expect(
      isInteractive(config({ tap_to_live: true, tap_action: { action: 'none' } as ActionConfig })),
    ).toBe(false);
  });
});

describe('ActionController — the onTap seam', () => {
  it('consumes the tap it claims, and leaves the rest alone', () => {
    vi.useFakeTimers();
    let taps = 0;
    const built = rig(
      config({
        mode: 'snapshot',
        tap_to_live: true,
        hold_action: { action: 'more-info' } as ActionConfig,
        double_tap_action: { action: 'url', url_path: '/wall' } as ActionConfig,
      }),
      () => {
        taps += 1;
        return true;
      },
    );

    tap(built.target);
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 2);
    expect(taps).toBe(1);
    expect(built.fired).toEqual([]);

    // Hold and double-tap never consult it.
    built.target.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(HOLD_MS);
    built.target.dispatchEvent(pointer('pointerup'));
    tap(built.target);
    tap(built.target);
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 2);

    expect(taps).toBe(1);
    expect(built.actions()).toEqual(['hold', 'double_tap']);
  });

  it('consumes a tap even when tap_action is none', () => {
    vi.useFakeTimers();
    let taps = 0;
    const built = rig(
      config({
        mode: 'snapshot',
        tap_to_live: true,
        tap_action: { action: 'none' } as ActionConfig,
      }),
      () => {
        taps += 1;
        return true;
      },
    );

    tap(built.target);
    built.target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(taps).toBe(2);
    expect(built.fired).toEqual([]);
  });

  it('falls through to tap_action when it declines the tap', () => {
    vi.useFakeTimers();
    let taps = 0;
    const built = rig(config(), () => {
      taps += 1;
      return false;
    });

    tap(built.target);

    expect(taps).toBe(1);
    expect(built.actions()).toEqual(['tap']);
  });
});

describe('ActionController — tap', () => {
  it('fires immediately when no double-tap is configured', () => {
    vi.useFakeTimers();
    const built = rig();

    tap(built.target);

    // Zero latency: not one timer tick has been advanced.
    expect(built.actions()).toEqual(['tap']);
    expect(built.fired[0].config.entity).toBe('camera.front_yard');
  });

  it('does not fire when tap_action is none', () => {
    const built = rig(config({ tap_action: { action: 'none' } as ActionConfig }));
    tap(built.target);
    expect(built.fired).toEqual([]);
  });

  it('ignores gestures entirely before a config arrives', () => {
    const built = rig(null);
    tap(built.target);
    expect(built.fired).toEqual([]);
  });

  it('reads the current config, not the one present at attach time', () => {
    const built = rig();
    built.setConfig(config({ tap_action: { action: 'toggle' } as ActionConfig }));

    tap(built.target);

    expect(built.fired[0].config.tap_action).toEqual({ action: 'toggle' });
  });

  it('ignores secondary pointers and non-primary mouse buttons', () => {
    const built = rig();

    // Second finger of a pinch.
    built.target.dispatchEvent(pointer('pointerdown', { pointerId: 2, isPrimary: false }));
    built.target.dispatchEvent(pointer('pointerup', { pointerId: 2, isPrimary: false }));
    // Right-click.
    built.target.dispatchEvent(pointer('pointerdown', { pointerId: 3, button: 2 }));
    built.target.dispatchEvent(pointer('pointerup', { pointerId: 3, button: 2 }));

    expect(built.fired).toEqual([]);
  });
});

describe('ActionController — double tap', () => {
  const withDouble = () =>
    rig(config({ double_tap_action: { action: 'url', url_path: '/wall' } as ActionConfig }));

  it('waits out the window before committing to a single tap', () => {
    vi.useFakeTimers();
    const built = withDouble();

    tap(built.target);
    expect(built.fired).toEqual([]);

    vi.advanceTimersByTime(DOUBLE_TAP_MS - 1);
    expect(built.fired).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(built.actions()).toEqual(['tap']);
  });

  it('fires double_tap instead when the second tap lands inside the window', () => {
    vi.useFakeTimers();
    const built = withDouble();

    tap(built.target);
    vi.advanceTimersByTime(DOUBLE_TAP_MS - 50);
    tap(built.target);

    expect(built.actions()).toEqual(['double_tap']);

    // The suppressed single tap must not resurface later.
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 4);
    expect(built.actions()).toEqual(['double_tap']);
  });

  it('treats two slow taps as two single taps', () => {
    vi.useFakeTimers();
    const built = withDouble();

    tap(built.target);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 10);
    tap(built.target);
    vi.advanceTimersByTime(DOUBLE_TAP_MS);

    expect(built.actions()).toEqual(['tap', 'tap']);
  });

  it('does not delay a tap when double_tap_action is none', () => {
    vi.useFakeTimers();
    const built = rig();
    tap(built.target);
    tap(built.target);
    expect(built.actions()).toEqual(['tap', 'tap']);
  });

  it('still recognises a double tap on a card whose single tap does nothing', () => {
    vi.useFakeTimers();
    const built = rig(
      config({
        tap_action: { action: 'none' } as ActionConfig,
        double_tap_action: { action: 'more-info' } as ActionConfig,
      }),
    );

    tap(built.target);
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 2);
    expect(built.fired).toEqual([]);

    tap(built.target);
    tap(built.target);
    expect(built.actions()).toEqual(['double_tap']);
  });
});

describe('ActionController — hold', () => {
  const withHold = (extra: Partial<NormalizedCardConfig> = {}) =>
    rig(config({ hold_action: { action: 'more-info' } as ActionConfig, ...extra }));

  it('fires on release once the threshold is passed, and suppresses the tap', () => {
    vi.useFakeTimers();
    const built = withHold();

    built.target.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(HOLD_MS);
    expect(built.fired).toEqual([]); // hold fires on release, not at the threshold

    built.target.dispatchEvent(pointer('pointerup'));
    expect(built.actions()).toEqual(['hold']);
  });

  it('is still a tap just below the threshold', () => {
    vi.useFakeTimers();
    const built = withHold();

    built.target.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(HOLD_MS - 1);
    built.target.dispatchEvent(pointer('pointerup'));

    expect(built.actions()).toEqual(['tap']);
  });

  it('leaves a slow press as a tap when hold_action is none', () => {
    vi.useFakeTimers();
    const built = rig();

    built.target.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(HOLD_MS * 4);
    built.target.dispatchEvent(pointer('pointerup'));

    expect(built.actions()).toEqual(['tap']);
  });

  it('fires nothing at all when every slot is none', () => {
    vi.useFakeTimers();
    const built = rig(config({ tap_action: { action: 'none' } as ActionConfig }));

    built.target.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(HOLD_MS * 2);
    built.target.dispatchEvent(pointer('pointerup'));

    expect(built.fired).toEqual([]);
  });

  it('lets an earlier single tap stand when a long press follows it', () => {
    vi.useFakeTimers();
    const built = withHold({
      double_tap_action: { action: 'url', url_path: '/wall' } as ActionConfig,
    });

    tap(built.target);
    built.target.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(HOLD_MS);
    built.target.dispatchEvent(pointer('pointerup'));
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 4);

    // The first tap committed at DOUBLE_TAP_MS (no second *tap* arrived — a
    // press is not a tap), then the press resolved as a hold. This is exactly
    // what Home Assistant's own action handler does with the same input.
    expect(built.actions()).toEqual(['tap', 'hold']);
  });

  it('suppresses the context menu only while a hold gesture is in flight', () => {
    const built = withHold();

    const idle = new Event('contextmenu', { bubbles: true, cancelable: true });
    built.target.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);

    built.target.dispatchEvent(pointer('pointerdown'));
    const pressed = new Event('contextmenu', { bubbles: true, cancelable: true });
    built.target.dispatchEvent(pressed);
    expect(pressed.defaultPrevented).toBe(true);
  });
});

describe('ActionController — cancellation', () => {
  it('abandons the gesture past the movement slop', () => {
    const built = rig();

    built.target.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100 }));
    built.target.dispatchEvent(
      pointer('pointermove', { clientX: 100, clientY: 100 + TAP_SLOP_PX + 1 }),
    );
    built.target.dispatchEvent(pointer('pointerup', { clientX: 100, clientY: 111 }));

    expect(built.fired).toEqual([]);
  });

  it('tolerates a wobble inside the slop', () => {
    const built = rig();

    built.target.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100 }));
    built.target.dispatchEvent(pointer('pointermove', { clientX: 103, clientY: 104 }));
    built.target.dispatchEvent(pointer('pointerup', { clientX: 103, clientY: 104 }));

    expect(built.actions()).toEqual(['tap']);
  });

  it('abandons the gesture on pointercancel and on leaving the card', () => {
    const built = rig();

    built.target.dispatchEvent(pointer('pointerdown'));
    built.target.dispatchEvent(pointer('pointercancel'));
    built.target.dispatchEvent(pointer('pointerup'));
    expect(built.fired).toEqual([]);

    built.target.dispatchEvent(pointer('pointerdown'));
    built.target.dispatchEvent(pointer('pointerleave'));
    built.target.dispatchEvent(pointer('pointerup'));
    expect(built.fired).toEqual([]);
  });

  it('cancels a pending hold when the pointer is taken away', () => {
    vi.useFakeTimers();
    const built = rig(config({ hold_action: { action: 'more-info' } as ActionConfig }));

    built.target.dispatchEvent(pointer('pointerdown'));
    built.target.dispatchEvent(pointer('pointercancel'));
    vi.advanceTimersByTime(HOLD_MS * 2);
    built.target.dispatchEvent(pointer('pointerup'));

    expect(built.fired).toEqual([]);
  });

  it('detach drops listeners and any tap still waiting to fire', () => {
    vi.useFakeTimers();
    const built = rig(
      config({ double_tap_action: { action: 'url', url_path: '/wall' } as ActionConfig }),
    );

    tap(built.target);
    built.controller.detach();
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 4);
    expect(built.fired).toEqual([]);

    tap(built.target);
    expect(built.fired).toEqual([]);
    expect(built.controller.target).toBeNull();
  });

  it('re-attaching to a new element moves the listeners', () => {
    const built = rig();
    const next = document.createElement('div');
    document.body.appendChild(next);

    built.controller.attach(next);
    expect(built.controller.target).toBe(next);

    tap(built.target);
    expect(built.fired).toEqual([]);

    tap(next);
    expect(built.actions()).toEqual(['tap']);
    next.remove();
  });
});

describe('ActionController — keyboard', () => {
  function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  }

  it('activates on Enter and Space, immediately', () => {
    vi.useFakeTimers();
    const built = rig(
      config({ double_tap_action: { action: 'url', url_path: '/wall' } as ActionConfig }),
    );

    built.target.dispatchEvent(key('Enter'));
    built.target.dispatchEvent(key(' '));

    // No double-tap delay for a keyboard: that idiom is touch-only.
    expect(built.actions()).toEqual(['tap', 'tap']);
  });

  it('prevents the default so Space does not scroll the dashboard', () => {
    const built = rig();
    const event = key(' ');
    built.target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores auto-repeat and other keys', () => {
    const built = rig();
    built.target.dispatchEvent(key('Enter', { repeat: true }));
    built.target.dispatchEvent(key('a'));
    built.target.dispatchEvent(key('ArrowDown'));
    expect(built.fired).toEqual([]);
  });

  it('does nothing when the card is not interactive', () => {
    const built = rig(
      config({
        tap_action: { action: 'none' } as ActionConfig,
        hold_action: { action: 'more-info' } as ActionConfig,
      }),
    );
    const event = key('Enter');
    built.target.dispatchEvent(event);
    expect(built.fired).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});
