/**
 * `reliability/retry.ts` — the backoff maths and the one place `setTimeout`
 * lives.
 *
 * Two small, dependency-free pieces:
 *
 * - {@link ExponentialBackoff} — the tier-2 delay sequence
 *   (`base × factor^n`, capped, then jittered). Pure arithmetic over an
 *   injectable RNG, so tests can assert the sequence exactly.
 * - {@link RetryTimer} — a single-shot, re-armable timer with an `advance()`
 *   escape hatch for "an external event says try *now*".
 *
 * Keeping every pending retry behind one timer object matters for frozen tabs:
 * a backgrounded browser does not run pending timers, so recovery has to be
 * driven by lifecycle events that call {@link RetryTimer.advance}. That is only
 * possible because the supervisor never calls `setTimeout` directly.
 *
 * Policy constants live in `types.ts` and are the defaults here; nothing in
 * this module re-declares them.
 */

import {
  REMOUNT_BACKOFF_BASE_MS,
  REMOUNT_BACKOFF_CAP_MS,
  REMOUNT_BACKOFF_FACTOR,
  REMOUNT_BACKOFF_JITTER_MAX,
  REMOUNT_BACKOFF_JITTER_MIN,
} from '../types';

/* -------------------------------------------------------------------------- */
/* Timer injection                                                             */
/* -------------------------------------------------------------------------- */

/** Opaque handle returned by the injected timer API. */
export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/**
 * The slice of the timer API this layer uses.
 *
 * Injectable so tests can drive time by hand; the default implementation looks
 * the globals up *per call* rather than capturing them at module load, so
 * `vi.useFakeTimers()` still intercepts everything.
 */
export interface TimerApi {
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(handler: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/** The real timers, resolved lazily so fake-timer installs are honoured. */
export const defaultTimers: TimerApi = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle),
};

/* -------------------------------------------------------------------------- */
/* Exponential backoff                                                         */
/* -------------------------------------------------------------------------- */

/** Overrides for {@link ExponentialBackoff}; every field defaults to the spec. */
export interface ExponentialBackoffOptions {
  /** Delay for the first failure, before jitter. Default 5 s. */
  baseMs?: number;
  /** Multiplier per consecutive failure. Default 2. */
  factor?: number;
  /** Upper bound on the pre-jitter delay. Default 600 s. */
  capMs?: number;
  /** Lower jitter multiplier. Default 0.5. */
  jitterMin?: number;
  /** Upper jitter multiplier. Default 1.0. */
  jitterMax?: number;
  /** Uniform `[0, 1)` source. Default `Math.random`; injected by tests. */
  random?: () => number;
}

/**
 * Jittered exponential backoff for tier-2 remounts.
 *
 * ```text
 * delay(n) = min(base × factor^n, cap) × U[jitterMin, jitterMax]
 * ```
 *
 * The jitter is what keeps 2–4 cards on the same dashboard from hammering a
 * recovering Frigate in lockstep. There is no terminal state: the sequence
 * simply flattens at the cap and keeps going forever, which is the kiosk
 * semantics the card is built for.
 */
export class ExponentialBackoff {
  private readonly baseMs: number;
  private readonly factor: number;
  private readonly capMs: number;
  private readonly jitterMin: number;
  private readonly jitterMax: number;
  private readonly random: () => number;

  /** How many delays have been produced since the last {@link reset}. */
  private failures = 0;

  constructor(options: ExponentialBackoffOptions = {}) {
    this.baseMs = options.baseMs ?? REMOUNT_BACKOFF_BASE_MS;
    this.factor = options.factor ?? REMOUNT_BACKOFF_FACTOR;
    this.capMs = options.capMs ?? REMOUNT_BACKOFF_CAP_MS;
    this.jitterMin = options.jitterMin ?? REMOUNT_BACKOFF_JITTER_MIN;
    this.jitterMax = options.jitterMax ?? REMOUNT_BACKOFF_JITTER_MAX;
    this.random = options.random ?? Math.random;
  }

  /** Consecutive failures counted so far. */
  get attempts(): number {
    return this.failures;
  }

  /** The pre-jitter delay the next {@link next} call will start from. */
  peek(): number {
    return Math.min(this.baseMs * Math.pow(this.factor, this.failures), this.capMs);
  }

  /** The next delay in milliseconds, advancing the sequence. */
  next(): number {
    const raw = this.peek();
    this.failures += 1;
    const jitter = this.jitterMin + this.random() * (this.jitterMax - this.jitterMin);
    return Math.round(raw * jitter);
  }

  /** Forget the failure history — called whenever the stream plays again. */
  reset(): void {
    this.failures = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Retry timer                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A single-shot timer that can be re-armed, cancelled, or fired early.
 *
 * `schedule()` always replaces any pending callback, so a re-arm can never
 * leave two attempts racing. `advance()` exists for the lifecycle triggers
 * (`hass-reconnected`, `page-resumed`): when the network demonstrably just came
 * back there is no reason to sit out the remaining backoff.
 */
export class RetryTimer {
  private readonly timers: TimerApi;
  private handle: TimerHandle | null = null;
  private callback: (() => void) | null = null;
  private scheduledDelayMs: number | undefined;

  constructor(timers: TimerApi = defaultTimers) {
    this.timers = timers;
  }

  /** Whether a callback is currently waiting to fire. */
  get pending(): boolean {
    return this.callback !== null;
  }

  /** The delay the pending callback was scheduled with, if any. */
  get delayMs(): number | undefined {
    return this.pending ? this.scheduledDelayMs : undefined;
  }

  /** Arm the timer, replacing anything already scheduled. */
  schedule(delayMs: number, callback: () => void): void {
    this.cancel();
    this.callback = callback;
    this.scheduledDelayMs = delayMs;
    this.handle = this.timers.setTimeout(() => this.fire(), delayMs);
  }

  /**
   * Fire the pending callback immediately.
   *
   * @returns `true` if something was pending (and has now run).
   */
  advance(): boolean {
    if (!this.pending) return false;
    this.fire();
    return true;
  }

  /** Drop any pending callback. Safe to call at any time. */
  cancel(): void {
    if (this.handle !== null) {
      this.timers.clearTimeout(this.handle);
      this.handle = null;
    }
    this.callback = null;
    this.scheduledDelayMs = undefined;
  }

  /** Clear state *before* running the callback so it may re-schedule freely. */
  private fire(): void {
    const callback = this.callback;
    this.cancel();
    callback?.();
  }
}
