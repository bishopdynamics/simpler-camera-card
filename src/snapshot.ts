/**
 * `snapshot.ts` — the polled-stills loop behind `mode: snapshot`.
 *
 * Snapshot mode is the low-resource answer to "I do not need video": no
 * websocket, no `MediaSource`, no decode pipeline — just Home Assistant's own
 * signed camera snapshot, re-fetched every `refresh_interval` seconds. That
 * makes the whole reliability story a timer plus a retry-on-the-next-tick rule,
 * which is why none of the stream stack (supervisor, player, watchdog) is
 * constructed in this mode.
 *
 * Invariants:
 *
 * - **The loop never dies.** Every failure — a refused signature, a missing
 *   entity, an image that will not decode — is one dropped poll. The timer keeps
 *   running forever, so recovery is automatic and needs no human. Kiosk
 *   semantics, exactly as in `reliability/supervisor.ts`.
 * - **Every tick re-signs.** `resolvePosterUrl` is called per tick because a
 *   snapshot's `access_token` rotates every ~5 minutes; a cached URL would go
 *   stale within the hour.
 * - **Never blank, never tear.** Each URL is preloaded into a detached `Image`
 *   and {@link SnapshotLoopDeps.onFrame} only fires once it has decoded, so the
 *   card swaps a frame it knows is good. A failed refresh simply leaves the last
 *   good frame on screen.
 * - **One tick at a time.** A timer firing while a tick is still in flight is
 *   dropped rather than queued — a slow network must not build a backlog.
 * - **…but never for longer than one deadline.** A tick that has not finished
 *   within {@link SnapshotLoop.tickTimeoutMs} is abandoned and counted as a
 *   failure, so the overlap guard above can never become a deadlock: a request
 *   a proxy accepts and never answers costs one poll, not the whole loop.
 * - **Abandoned work is silent.** `pause()` and `destroy()` invalidate the tick
 *   in flight; its callbacks become no-ops rather than delivering a frame the
 *   card no longer wants. So does every restart (`resume()`, `refreshNow()`):
 *   those promise a poll *now*, which means the tick still in flight — signed
 *   against the world before the reconnect — is retired rather than allowed to
 *   hold the overlap guard against the fresh one.
 *
 * ## Wiring
 *
 * ```ts
 * const loop = new SnapshotLoop({
 *   endpoint: endpointResolver,
 *   getHass: () => this.hass,
 *   getConfig: () => this.config,
 *   onFrame: (url) => { this.snapshotUrl = url; },
 *   onStale: () => { this.stale = true; },
 *   onEndpointError: (error) => { this.error = error; },
 * });
 * loop.start();
 * ```
 */

import { EndpointError } from './endpoint';
import { LOG_PREFIX, describeError, type Logger } from './errors';
import { defaultTimers, type TimerApi, type TimerHandle } from './reliability/retry';
import {
  SNAPSHOT_STALE_AFTER_FAILURES,
  SNAPSHOT_TICK_TIMEOUT_FLOOR_MS,
  type EndpointResolver,
  type HomeAssistant,
  type NormalizedCardConfig,
} from './types';

/**
 * Everything the loop needs from the outside world.
 *
 * `getHass` / `getConfig` are *getters* rather than values for the same reason
 * the supervisor takes getters: Home Assistant hands over a new `hass` object on
 * every state change in the system, and `setConfig` can be called at any time.
 * The trailing fields are test seams with production-correct defaults.
 */
export interface SnapshotLoopDeps {
  /** Signs a fresh snapshot URL per tick. Never cached — the token rotates. */
  endpoint: EndpointResolver;
  /** Current `hass`. Returning nullish makes the tick fail (and retry). */
  getHass: () => HomeAssistant | null | undefined;
  /** The normalized config; the loop reads `refresh_interval` and `camera`. */
  getConfig: () => NormalizedCardConfig;

  /** A snapshot has been fetched *and decoded*: safe to show. */
  onFrame: (url: string) => void;
  /**
   * At least {@link SNAPSHOT_STALE_AFTER_FAILURES} consecutive polls have
   * failed. Called again on every further failure, with the running count, so
   * the card can keep its indicator honest.
   */
  onStale: (consecutiveFailures: number) => void;
  /**
   * A tick rejected with an {@link EndpointError} — i.e. a config/plumbing
   * problem worth telling the user about, not a transient blip.
   */
  onEndpointError: (error: unknown) => void;

  /** Builds the detached preload element. Defaults to `new Image()`. */
  createImage?: () => HTMLImageElement;
  /** Injectable timers, shared with the reliability layer's defaults. */
  timers?: TimerApi;
  /** Defaults to the real `console`. */
  logger?: Logger;
}

/**
 * Polls the camera's signed snapshot URL on the configured interval.
 *
 * One instance per card start; `destroy()` retires it for good (a paused loop
 * is resumed, a destroyed one is replaced).
 */
export class SnapshotLoop {
  private readonly deps: SnapshotLoopDeps;
  private readonly timers: TimerApi;
  private readonly log: Logger;
  private readonly createImage: () => HTMLImageElement;

  /** The repeating tick; `null` while stopped or paused. */
  private timer: TimerHandle | null = null;

  private started = false;
  private paused = false;
  private destroyed = false;

  /**
   * Guards against overlapping ticks on a slow network: the token of the tick
   * holding the guard, or `null` while the loop is idle.
   *
   * A token rather than a boolean because a tick can be abandoned (by
   * {@link invalidate}, or by its deadline) and settle long afterwards — or
   * never. Releasing the guard is therefore conditional on still owning it, so
   * a straggler cannot free the guard a *later* tick is holding.
   */
  private tickInFlight: number | null = null;

  /** Hands each tick its own {@link tickInFlight} token. */
  private tickCounter = 0;

  /** Deadline for the tick in flight; `null` when there is none. */
  private tickDeadline: TimerHandle | null = null;

  /** Stamps each tick; results from older generations are dropped. */
  private generation = 0;

  /** Consecutive failed polls; reset by every decoded frame. */
  private failures = 0;

  /** Abandons the preload in flight, if any. */
  private abandonPreload: (() => void) | null = null;

  constructor(deps: SnapshotLoopDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? defaultTimers;
    this.log = deps.logger ?? console;
    this.createImage = deps.createImage ?? ((): HTMLImageElement => new Image());
  }

  /**
   * Consecutive failed polls right now; `0` whenever the last poll worked.
   *
   * @internal The card learns the count from `onStale`; this getter is for the
   * loop's own tests.
   */
  get consecutiveFailures(): number {
    return this.failures;
  }

  /**
   * Whether polling is currently suspended (the dashboard is hidden).
   *
   * @internal The card owns the pause/resume calls, so it already knows; this
   * getter is for the loop's own tests.
   */
  get isPaused(): boolean {
    return this.paused;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /** Poll immediately, then every `refresh_interval` seconds. Idempotent. */
  start(): void {
    if (this.destroyed || this.started) return;
    this.started = true;
    this.paused = false;
    this.failures = 0;
    this.restart();
  }

  /**
   * Suspend polling — the dashboard is hidden.
   *
   * Nothing is torn down (there is nothing to tear down: no socket, no
   * decoder), so this is free and instant, which is why it needs none of the
   * supervisor's grace period. The tick in flight is abandoned so a frame
   * cannot land on a card nobody is looking at.
   */
  pause(): void {
    if (this.destroyed || !this.started || this.paused) return;
    this.paused = true;
    this.invalidate();
    this.cancelTimer();
  }

  /** Visible again: poll straight away and restart the interval. Idempotent. */
  resume(): void {
    if (this.destroyed || !this.started) return;
    this.paused = false;
    this.restart();
  }

  /**
   * Poll now and restart the interval from this moment — for the
   * `hass.connected` false→true edge, where waiting out the rest of an interval
   * would show a stale frame for no reason. A no-op while paused: a hidden
   * dashboard stays hidden.
   */
  refreshNow(): void {
    if (this.destroyed || !this.started || this.paused) return;
    this.restart();
  }

  /** Cancel the timer, abandon the tick in flight, and retire the loop. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.started = false;
    this.invalidate();
    this.cancelTimer();
  }

  /* ------------------------------------------------------------------ */
  /* The tick                                                            */
  /* ------------------------------------------------------------------ */

  /** (Re-)arm the interval and poll immediately. */
  private restart(): void {
    this.cancelTimer();
    // The tick in flight, if any, belongs to the world *before* this restart —
    // a pre-reconnect `hass`, a signature minted against the old session, or a
    // request that may never answer at all. Retire it, both so its late result
    // cannot be published and so the overlap guard below does not swallow the
    // immediate poll that `resume()` and `refreshNow()` promise.
    this.invalidate();
    const intervalMs = Math.max(0, this.deps.getConfig().refresh_interval) * 1000;
    this.timer = this.timers.setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * How long the tick in flight may run before it is abandoned.
   *
   * One `refresh_interval` — a poll still going when the next one is due is
   * late by definition — but never less than
   * {@link SNAPSHOT_TICK_TIMEOUT_FLOOR_MS}.
   */
  private tickTimeoutMs(): number {
    const intervalMs = Math.max(0, this.deps.getConfig().refresh_interval) * 1000;
    return Math.max(intervalMs, SNAPSHOT_TICK_TIMEOUT_FLOOR_MS);
  }

  /**
   * One poll: re-sign, preload, publish.
   *
   * Failures of every kind — nullish `hass`, no snapshot URL, a rejected
   * resolution, an image that will not decode, work that never finishes at all
   * — land in the same counter and cost exactly one interval. There is no
   * failure that stops the loop.
   */
  private async tick(): Promise<void> {
    if (this.destroyed || !this.started || this.paused) return;
    // A timer firing on top of a slow tick is dropped, not queued.
    if (this.tickInFlight !== null) return;

    const token = ++this.tickCounter;
    this.tickInFlight = token;
    const generation = this.generation;
    // Nothing below is guaranteed to settle: `resolvePosterUrl` waits on a
    // websocket command, and `preload()` waits on events a hung proxy will
    // never fire. The deadline is what makes the guard above safe.
    this.tickDeadline = this.timers.setTimeout(() => this.expireTick(token), this.tickTimeoutMs());
    try {
      const hass = this.deps.getHass();
      if (!hass) {
        this.recordFailure('Home Assistant is not available yet');
        return;
      }

      const url = await this.deps.endpoint.resolvePosterUrl(hass, this.deps.getConfig());
      if (!this.isCurrent(generation)) return;
      if (!url) {
        this.recordFailure(`no snapshot URL for "${this.deps.getConfig().camera}"`);
        return;
      }

      const loaded = await this.preload(url);
      if (!this.isCurrent(generation)) return;
      if (!loaded) {
        this.recordFailure('the snapshot image failed to load');
        return;
      }

      this.failures = 0;
      this.deps.onFrame(url);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      // Config-class problems (a missing entity, a refused signature) are worth
      // surfacing; the loop still just retries on the next tick.
      if (error instanceof EndpointError) this.deps.onEndpointError(error);
      this.recordFailure(describeError(error));
    } finally {
      this.releaseTick(token);
    }
  }

  /**
   * The deadline struck: give up on this tick so the loop can carry on.
   *
   * The abandoned work goes through the same machinery as a pause — a new
   * generation, the preload's `src` dropped — so a result landing later is
   * discarded rather than published. What is different is that the failure is
   * *counted*: an unanswered poll must reach the stale indicator like any other.
   */
  private expireTick(token: number): void {
    if (this.tickInFlight !== token) return;
    const seconds = this.tickTimeoutMs() / 1000;
    this.invalidate();
    this.recordFailure(`the snapshot poll did not finish within ${seconds}s`);
  }

  /** Free the overlap guard, if this tick is still the one holding it. */
  private releaseTick(token: number): void {
    if (this.tickInFlight !== token) return;
    this.tickInFlight = null;
    this.cancelDeadline();
  }

  private cancelDeadline(): void {
    if (this.tickDeadline === null) return;
    this.timers.clearTimeout(this.tickDeadline);
    this.tickDeadline = null;
  }

  /**
   * Fetch and decode `url` off-screen.
   *
   * Resolves `true` once the browser has the bitmap, so the card's visible
   * `<img>` swap is a cache hit rather than a fresh (blanking) request.
   */
  private preload(url: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const image = this.createImage();
      const finish = (loaded: boolean): void => {
        image.onload = null;
        image.onerror = null;
        this.abandonPreload = null;
        resolve(loaded);
      };
      // Only ever one preload in flight (see the overlap guard), so the pending
      // abandon hook can be replaced outright.
      this.abandonPreload = () => {
        // Dropping the src tells the browser to stop fetching a frame nobody
        // will show.
        image.src = '';
        finish(false);
      };
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = url;
    });
  }

  private recordFailure(why: string): void {
    this.failures += 1;
    this.log.info(`${LOG_PREFIX} snapshot refresh failed (${this.failures} in a row): ${why}`);
    if (this.failures >= SNAPSHOT_STALE_AFTER_FAILURES) this.deps.onStale(this.failures);
  }

  /**
   * Retire the tick in flight: its result is no longer wanted.
   *
   * The guard and the deadline go with it. Freeing the guard here is what makes
   * `pause()` and `restart()` safe: when the abandoned tick is stuck somewhere
   * it cannot be woken from — a websocket command that never answers — nothing
   * else would ever release it, so `resume()` would find the loop wedged and
   * `refreshNow()` would silently do nothing.
   */
  private invalidate(): void {
    this.generation += 1;
    this.tickInFlight = null;
    this.cancelDeadline();
    const abandon = this.abandonPreload;
    this.abandonPreload = null;
    abandon?.();
  }

  private isCurrent(generation: number): boolean {
    return this.started && !this.destroyed && !this.paused && generation === this.generation;
  }
}
