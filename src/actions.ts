/**
 * `actions.ts` — tap / hold / double-tap, with HA-standard semantics.
 *
 * The card implements **no** action behaviour of its own. It recognises a
 * gesture and fires Home Assistant's `hass-action` event; the frontend then runs
 * the whole pipeline — confirmations, the more-info dialog, navigation, URL
 * opening, service calls, assist. That is the entire point: `more-info` on a
 * camera has to open HA's *live* camera dialog, and only HA can do that.
 *
 * Two deliberate non-dependencies:
 *
 * - **No `custom-card-helpers`.** It is a lagging vendored snapshot of the
 *   frontend types and drags in code we do not want in a single-file bundle.
 *   The `hass-action` event contract (`{ detail: { config, action } }`,
 *   bubbling and composed) has been stable since HA 2023.7.
 * - **No `ha-*` element.** Gesture recognition is ~150 lines of Pointer Events;
 *   depending on an internal HA custom element to get it would be a much bigger
 *   bet than writing it.
 *
 * ## Gesture rules
 *
 * - `tap` — pointer released without a hold or a second tap.
 * - `hold` — pointer held for {@link HOLD_MS}; fires on release and suppresses
 *   the tap.
 * - `double_tap` — a second tap begun within {@link DOUBLE_TAP_MS} of the first
 *   tap's release.
 *
 * The one exception to "the card implements no action behaviour" is the
 * {@link ActionControllerOptions.onTap} seam: the card may claim a *tap* for
 * itself (that is how `tap_to_live` toggles the live window), in which case no
 * `hass-action` is fired for it. Hold and double-tap are never intercepted.
 *
 * ## The two "only when configured" optimisations
 *
 * Waiting to see whether a second tap arrives costs {@link DOUBLE_TAP_MS} of
 * latency on *every* tap. On a wall-mounted kiosk that lag is the difference
 * between a card that feels native and one that feels broken, so the pending-tap
 * timer is armed **only when `double_tap_action` is configured**. With the
 * default config a tap fires the instant the pointer comes up.
 *
 * The same reasoning applies to holds: the hold timer is armed only when
 * `hold_action` is configured. Home Assistant's own action handler always tracks
 * the hold and then no-ops for `action: none`, which turns a slow press into a
 * dead zone where nothing at all happens. Here, with the default
 * `hold_action: none`, a slow press is still a tap.
 *
 * Consumed by: `card.ts` (the only caller).
 */

import type { TimerHandle } from './reliability/retry';
import type { ActionConfig, NormalizedCardConfig } from './types';

/* -------------------------------------------------------------------------- */
/* Timing constants                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How long the pointer must stay down to count as a hold. 500 ms is Home
 * Assistant's own `action-handler` value; matching it keeps muscle memory
 * consistent with every builtin card on the same dashboard.
 */
export const HOLD_MS = 500;

/**
 * Maximum gap between two taps for them to be one double-tap. Also the exact
 * latency a tap pays *only when* `double_tap_action` is configured (see the
 * module docs). 250 ms is Home Assistant's value.
 */
export const DOUBLE_TAP_MS = 250;

/**
 * How far the pointer may travel before the gesture is abandoned, in CSS px.
 *
 * This is what stops a scroll from being read as a tap: dragging a touch
 * dashboard usually starts with a finger landing on a card, and without a slop
 * threshold every scroll would open a more-info dialog. 10 px is a little under
 * Chromium's own ~15 px touch-slop, chosen so the card errs towards "that was a
 * scroll" — a missed tap is retried in half a second, a spurious one opens a
 * dialog over the user's video.
 */
export const TAP_SLOP_PX = 10;

/* -------------------------------------------------------------------------- */
/* The `hass-action` event                                                     */
/* -------------------------------------------------------------------------- */

/** The three gestures, named exactly as Home Assistant names them. */
export type GestureAction = 'tap' | 'hold' | 'double_tap';

/**
 * The `config` half of the event detail: the object HA's `handleAction()`
 * inspects.
 *
 * It reads the slot for the gesture (`<action>_action`), and — for `more-info`
 * and `toggle` — falls back to this object's `entity` when the slot does not
 * name one of its own. Carrying all three slots plus `entity` is therefore
 * exactly what makes a bare `tap_action: { action: more-info }` open the camera.
 */
export interface HassActionConfig {
  /** The card's camera entity; HA's fallback target for `more-info`/`toggle`. */
  entity: string;
  tap_action: ActionConfig;
  hold_action: ActionConfig;
  double_tap_action: ActionConfig;
}

/** `detail` of the `hass-action` event. */
export interface HassActionDetail {
  config: HassActionConfig;
  action: GestureAction;
}

/** Build the {@link HassActionConfig} Home Assistant expects to receive. */
export function hassActionConfig(config: NormalizedCardConfig): HassActionConfig {
  return {
    entity: config.camera,
    tap_action: config.tap_action,
    hold_action: config.hold_action,
    double_tap_action: config.double_tap_action,
  };
}

/**
 * Which action slot a gesture resolves to.
 *
 * `normalizeConfig()` guarantees all three slots exist, so this never has to
 * invent a default.
 */
export function resolveAction(config: NormalizedCardConfig, action: GestureAction): ActionConfig {
  switch (action) {
    case 'hold':
      return config.hold_action;
    case 'double_tap':
      return config.double_tap_action;
    default:
      return config.tap_action;
  }
}

/**
 * Dispatch `hass-action` from `element`.
 *
 * `bubbles` + `composed` so it escapes the card's shadow root and reaches the
 * Lovelace ancestor that owns the handler.
 */
export function fireHassAction(
  element: HTMLElement,
  config: NormalizedCardConfig,
  action: GestureAction,
): void {
  const detail: HassActionDetail = { config: hassActionConfig(config), action };
  element.dispatchEvent(new CustomEvent('hass-action', { detail, bubbles: true, composed: true }));
}

/**
 * Whether the card should present itself as an interactive control — i.e.
 * whether it gets `role="button"`, `tabindex="0"`, a pointer cursor and
 * keyboard activation.
 *
 * Keyed on the *tap* alone: a surface that only responds to a hold is not a
 * button, and announcing it as one to a screen reader would promise an
 * activation that Enter cannot deliver.
 *
 * A `tap_to_live` snapshot card is interactive whatever `tap_action` says —
 * its tap is consumed locally by the go-live toggle (see
 * {@link ActionControllerOptions.onTap}), so even `tap_action: none` does
 * something real.
 */
export function isInteractive(config: NormalizedCardConfig): boolean {
  if (config.mode === 'snapshot' && config.tap_to_live) return true;
  return config.tap_action.action !== 'none';
}

/* -------------------------------------------------------------------------- */
/* Gesture recognition                                                         */
/* -------------------------------------------------------------------------- */

/** Construction options for {@link ActionController}. */
export interface ActionControllerOptions {
  /**
   * The **current** normalized config. Read fresh on every pointer event, never
   * snapshotted, so a `setConfig()` edit takes effect without re-attaching.
   * Returns `undefined` before Lovelace has configured the card, which disables
   * every gesture.
   */
  getConfig: () => NormalizedCardConfig | undefined;
  /**
   * Element the `hass-action` event is dispatched from. Defaults to the
   * attached target; the card passes its host element so the event leaves the
   * shadow root from the node Lovelace actually knows about.
   */
  getEventTarget?: () => HTMLElement | undefined;
  /**
   * Local handler for the *tap* gesture, consulted before the configured
   * `tap_action` — the seam `tap_to_live` uses to make a tap toggle the live
   * window instead of reaching Home Assistant.
   *
   * Returning `true` means "I consumed this tap": no `hass-action` is
   * dispatched. Returning `false` (or being absent) leaves tap handling exactly
   * as it was. Hold and double-tap never consult it.
   */
  onTap?: () => boolean;
}

/** The pointer currently being tracked. */
interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  /** Set when the hold timer fires; makes the release a `hold`, not a `tap`. */
  held: boolean;
}

/**
 * Recognises tap / hold / double-tap on one element and fires `hass-action`.
 *
 * Lifecycle: `attach(element)` → … → `detach()`. Attaching to a different
 * element detaches from the previous one first, so the card can call `attach()`
 * unconditionally after every render.
 *
 * Pointer capture is deliberately *not* used (its behaviour across engines and
 * test DOMs is uneven); instead a pointer that leaves the element or is
 * cancelled by the browser simply abandons the gesture, which is the same
 * outcome for the user.
 */
export class ActionController {
  private readonly options: ActionControllerOptions;

  private targetEl: HTMLElement | null = null;
  private gesture: Gesture | null = null;
  private holdTimer?: TimerHandle;

  /**
   * Live only while a tap is waiting to see whether a second tap follows, which
   * only ever happens when `double_tap_action` is configured.
   */
  private pendingTapTimer?: TimerHandle;

  constructor(options: ActionControllerOptions) {
    this.options = options;
  }

  /** The element currently listened to, or `null`. */
  get target(): HTMLElement | null {
    return this.targetEl;
  }

  /** Listen on `target`. Idempotent for the same element. */
  attach(target: HTMLElement): void {
    if (this.targetEl === target) return;
    this.detach();
    this.targetEl = target;
    target.addEventListener('pointerdown', this.onPointerDown);
    target.addEventListener('pointermove', this.onPointerMove);
    target.addEventListener('pointerup', this.onPointerUp);
    target.addEventListener('pointercancel', this.onPointerCancel);
    target.addEventListener('pointerleave', this.onPointerCancel);
    target.addEventListener('contextmenu', this.onContextMenu);
    target.addEventListener('keydown', this.onKeyDown);
  }

  /**
   * Stop listening and drop every pending timer.
   *
   * Cancelling the pending-tap timer matters: without it a card removed from
   * the DOM 100 ms after a tap would still dispatch `hass-action` from an
   * orphaned node.
   */
  detach(): void {
    const target = this.targetEl;
    this.cancelGesture();
    this.clearPendingTap();
    this.targetEl = null;
    if (!target) return;
    target.removeEventListener('pointerdown', this.onPointerDown);
    target.removeEventListener('pointermove', this.onPointerMove);
    target.removeEventListener('pointerup', this.onPointerUp);
    target.removeEventListener('pointercancel', this.onPointerCancel);
    target.removeEventListener('pointerleave', this.onPointerCancel);
    target.removeEventListener('contextmenu', this.onContextMenu);
    target.removeEventListener('keydown', this.onKeyDown);
  }

  /* ------------------------------------------------------------------ */
  /* Pointer handlers                                                    */
  /* ------------------------------------------------------------------ */

  private readonly onPointerDown = (event: PointerEvent): void => {
    // Multi-touch: only the primary pointer can be a tap. A second finger is a
    // pinch/zoom as far as this card is concerned, and is ignored outright
    // rather than being allowed to cancel the primary gesture.
    if (event.isPrimary === false) return;
    // Secondary mouse buttons open context menus, they do not activate cards.
    if (event.button > 0) return;
    if (this.gesture) return;

    const config = this.options.getConfig();
    if (!config) return;

    this.gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      held: false,
    };

    // Only armed when a hold is configured — otherwise a slow press stays a tap.
    if (config.hold_action.action !== 'none') {
      this.holdTimer = setTimeout(() => {
        this.holdTimer = undefined;
        if (this.gesture) this.gesture.held = true;
      }, HOLD_MS);
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    // Past the slop this is a scroll or a drag, not a press.
    if (distance > TAP_SLOP_PX) this.cancelGesture();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.gesture = null;
    this.clearHoldTimer();

    const config = this.options.getConfig();
    if (!config) {
      this.clearPendingTap();
      return;
    }

    if (gesture.held) {
      // With the shipped constants a pending single tap always resolves before
      // a hold can (DOUBLE_TAP_MS < HOLD_MS), so this normally has nothing to
      // do — exactly as in HA's own handler. It is here so "one gesture, one
      // action" survives someone changing either constant.
      this.clearPendingTap();
      this.fire('hold', config);
      return;
    }

    if (this.pendingTapTimer !== undefined) {
      this.clearPendingTap();
      this.fire('double_tap', config);
      return;
    }

    if (config.double_tap_action.action !== 'none') {
      this.pendingTapTimer = setTimeout(() => {
        this.pendingTapTimer = undefined;
        const latest = this.options.getConfig();
        if (latest) this.fire('tap', latest);
      }, DOUBLE_TAP_MS);
      return;
    }

    // The common case: no double-tap configured, so no reason to wait.
    this.fire('tap', config);
  };

  /**
   * The browser took the pointer away (scroll took over, palm rejection, the
   * pointer left the card). A pending single tap is deliberately left running —
   * it belongs to an *earlier*, completed press.
   */
  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.gesture && this.gesture.pointerId !== event.pointerId) return;
    this.cancelGesture();
  };

  /**
   * Long-pressing on touch raises a context menu on top of the gesture. Suppress
   * it only while a press is actually in flight and a hold is configured, so a
   * right-click on desktop still gets its menu.
   */
  private readonly onContextMenu = (event: Event): void => {
    if (!this.gesture) return;
    if (this.options.getConfig()?.hold_action.action === 'none') return;
    event.preventDefault();
  };

  /**
   * Enter / Space activate the card, matching `role="button"`.
   *
   * A keyboard activation always fires immediately, even when a double-tap is
   * configured: "two taps within 250 ms" is a touch idiom, and holding a key
   * down would repeat rather than hold.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;

    const config = this.options.getConfig();
    if (!config || !isInteractive(config)) return;

    // Space scrolls the dashboard, Enter can submit an ancestor form.
    event.preventDefault();
    this.cancelGesture();
    this.clearPendingTap();
    this.fire('tap', config);
  };

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private fire(action: GestureAction, config: NormalizedCardConfig): void {
    // A local tap handler wins over the configured action. It sits *above* the
    // `none` check deliberately: a `tap_to_live` card with `tap_action: none`
    // still has to toggle.
    if (action === 'tap' && this.options.onTap?.() === true) return;
    // `action: none` is a configured "do nothing" — no event at all, so HA is
    // never asked to no-op on the card's behalf.
    if (resolveAction(config, action).action === 'none') return;
    const target = this.options.getEventTarget?.() ?? this.targetEl;
    if (target) fireHassAction(target, config, action);
  }

  private cancelGesture(): void {
    this.gesture = null;
    this.clearHoldTimer();
  }

  private clearHoldTimer(): void {
    if (this.holdTimer === undefined) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
  }

  private clearPendingTap(): void {
    if (this.pendingTapTimer === undefined) return;
    clearTimeout(this.pendingTapTimer);
    this.pendingTapTimer = undefined;
  }
}
