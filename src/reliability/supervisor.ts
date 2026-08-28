/**
 * `reliability/supervisor.ts` — the connection state machine.
 *
 * This is the card's reason to exist. The supervisor owns the player instance,
 * the watchdog, both retry tiers, the page-lifecycle rules and the escape
 * hatch. Everything else in the card reports *facts* — a socket closed, the
 * document became hidden, Home Assistant reconnected — and this module decides
 * what happens next.
 *
 * Invariants:
 *
 * - **One entry point for death.** All six reconnect triggers from the spec
 *   funnel into {@link StreamSupervisorImpl.handleDeath}; there is no second
 *   path that restarts a stream.
 * - **Players are one-shot.** A dead player is destroyed and forgotten, never
 *   revived. Tier-2 recovery is literally "throw the player away and build a
 *   new one", which is why no player contains retry logic.
 * - **Every attempt re-signs.** The endpoint resolver is called per attempt, so
 *   an HA restart rotating the signing key costs one failed attempt rather than
 *   permanent death (root cause #4 of the card this one replaces).
 * - **Retry forever.** There is no terminal failure state. Tier 1 is three fast
 *   in-place retries; tier 2 is full replacement on jittered exponential
 *   backoff that flattens at the cap and keeps going. Kiosks do not have a
 *   human to press reload.
 * - **Stale callbacks are ignored.** Every player is stamped with a generation;
 *   callbacks from a superseded player are dropped rather than trusted.
 *
 * ## Wiring
 *
 * ```ts
 * const supervisor = new StreamSupervisorImpl({
 *   createPlayer: () => new MsePlayer(),
 *   endpoint: endpointResolver,
 *   getHass: () => this.hass,
 *   getVideo: () => this.videoElement,
 *   getConfig: () => this.config,
 * });
 * supervisor.onStateChange = (state, detail) => this.renderStatus(state, detail);
 * supervisor.start();
 * ```
 *
 * Everything else in {@link StreamSupervisorDeps} is a test seam with a
 * production-correct default.
 */

import { LOG_PREFIX, describeError, type Logger } from '../errors';
import {
  HIDDEN_TEARDOWN_GRACE_MS,
  TIER1_MAX_RETRIES,
  TIER1_RETRY_DELAY_MS,
  type DeathReason,
  type EndpointResolver,
  type HomeAssistant,
  type LivePlayer,
  type NormalizedCardConfig,
  type PlayerFactory,
  type StreamSupervisor,
  type SupervisorExternalEvent,
  type SupervisorState,
  type SupervisorStateDetail,
} from '../types';
import {
  ExponentialBackoff,
  RetryTimer,
  defaultTimers,
  type ExponentialBackoffOptions,
  type TimerApi,
} from './retry';
import { FrameStallWatchdog, type StallWatchdog, type WatchdogOptions } from './watchdog';

/**
 * Everything the supervisor needs from the outside world.
 *
 * The first five fields are the real wiring, supplied by `card.ts`; the rest
 * are seams with production defaults. `getHass` / `getVideo` / `getConfig` are
 * *getters* rather than values because all three legitimately change while the
 * card lives: Home Assistant hands over a new `hass` object on every state
 * change, the video element is re-created by Lit re-renders, and `setConfig`
 * can be called again at any time.
 */
export interface StreamSupervisorDeps {
  /** Builds a player. Called once per attempt. */
  createPlayer: PlayerFactory;
  /** Signs a fresh go2rtc URL per attempt. Never cached — that is the point. */
  endpoint: EndpointResolver;
  /** Current `hass`. Returning nullish makes the attempt fail (and retry). */
  getHass: () => HomeAssistant | null | undefined;
  /** The mounted `<video>`. Returning nullish makes the attempt fail (and retry). */
  getVideo: () => HTMLVideoElement | null | undefined;
  /** The normalized config; the supervisor reads `reload_after_minutes_down`. */
  getConfig: () => NormalizedCardConfig;

  /**
   * Builds the stall watchdog. Defaults to a real {@link FrameStallWatchdog};
   * a factory (rather than an instance) so the supervisor always owns the
   * `onStall` wiring and the playback gate.
   */
  createWatchdog?: (options: WatchdogOptions) => StallWatchdog;
  /** The escape hatch's last resort. Defaults to `location.reload()`. */
  reloadPage?: () => void;
  /** Clock, for downtime accounting. Defaults to `Date.now`. */
  now?: () => number;
  /** Jitter source for the tier-2 backoff. Defaults to `Math.random`. */
  random?: () => number;
  /** Backoff overrides; policy defaults come from `types.ts`. */
  backoff?: ExponentialBackoffOptions;
  /** Injectable timers, shared with the watchdog. */
  timers?: TimerApi;
  /** Defaults to the real `console`. */
  logger?: Logger;
}

/** Carried from a failed attempt into the next one, for `SupervisorStateDetail`. */
interface PendingAttempt {
  reason?: DeathReason;
  attempt?: number;
  message?: string;
}

/**
 * The {@link StreamSupervisor} implementation.
 *
 * ```text
 *  idle ──start()──▶ connecting ──onPlaying──▶ playing
 *                        ▲  │                     │
 *                        │  │ onDead              │ onDead / stall
 *                        │  ▼                     ▼
 *                        ├── retrying   (tier 1: ≤3 × 2 s)
 *                        └── remounting (tier 2: jittered backoff, forever)
 * ```
 *
 * `stop()` returns to `idle` from anywhere. `visibility-hidden` also parks in
 * `idle` (see {@link StreamSupervisorImpl.suspend}).
 */
export class StreamSupervisorImpl implements StreamSupervisor {
  /** Assigned by the card before `start()`; a no-op until then. */
  onStateChange: (state: SupervisorState, detail?: SupervisorStateDetail) => void = () => {};

  private readonly deps: StreamSupervisorDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly reloadPage: () => void;
  private readonly backoff: ExponentialBackoff;
  private readonly watchdog: StallWatchdog;

  /** The next attempt (tier 1 or 2). */
  private readonly retryTimer: RetryTimer;
  /** The `visibility-hidden` grace period. */
  private readonly hiddenTimer: RetryTimer;
  /** The `reload_after_minutes_down` deadline. */
  private readonly escapeTimer: RetryTimer;

  private currentState: SupervisorState = 'idle';
  private started = false;
  /** Torn down because the dashboard is hidden; distinct from stopped. */
  private suspended = false;

  private player: LivePlayer | null = null;
  /** Stamps each attempt; callbacks from older generations are ignored. */
  private generation = 0;

  private tier1Attempts = 0;
  private remountAttempts = 0;
  private pending: PendingAttempt = {};
  /** When the stream was last known good; `null` while playing. */
  private downSince: number | null = null;

  constructor(deps: StreamSupervisorDeps) {
    this.deps = deps;
    this.log = deps.logger ?? console;
    this.now = deps.now ?? (() => Date.now());
    this.reloadPage = deps.reloadPage ?? (() => location.reload());

    const timers = deps.timers ?? defaultTimers;
    this.retryTimer = new RetryTimer(timers);
    this.hiddenTimer = new RetryTimer(timers);
    this.escapeTimer = new RetryTimer(timers);

    this.backoff = new ExponentialBackoff({
      random: deps.random,
      ...deps.backoff,
    });

    const watchdogOptions: WatchdogOptions = {
      onStall: () => this.handleStall(),
      // Frames are only expected once we believe we are playing, and never
      // while the dashboard is hidden or the supervisor is stopped.
      isPlaybackExpected: () => this.started && !this.suspended && this.currentState === 'playing',
      timers,
    };
    this.watchdog = deps.createWatchdog
      ? deps.createWatchdog(watchdogOptions)
      : new FrameStallWatchdog(watchdogOptions);
  }

  /**
   * Current state; the same value the last `onStateChange` reported.
   *
   * @internal The card tracks state through `onStateChange`; this getter exists
   * for the supervisor's own tests to assert on without a callback.
   */
  get state(): SupervisorState {
    return this.currentState;
  }

  /* ------------------------------------------------------------------ */
  /* StreamSupervisor                                                    */
  /* ------------------------------------------------------------------ */

  start(): void {
    if (this.started) return;
    this.started = true;
    this.suspended = false;
    this.tier1Attempts = 0;
    this.remountAttempts = 0;
    this.backoff.reset();
    this.pending = {};
    this.downSince = null;
    this.markDown();
    this.beginAttempt();
  }

  stop(): void {
    this.hiddenTimer.cancel();
    this.retryTimer.cancel();
    this.escapeTimer.cancel();
    this.teardownPlayer();
    // `detach()` disarms as part of its contract, so it is the whole teardown.
    // Deliberately not `destroy()`: `start()` may legitimately follow a
    // `stop()`, and a destroyed watchdog never watches again.
    this.watchdog.detach();

    this.started = false;
    this.suspended = false;
    this.tier1Attempts = 0;
    this.remountAttempts = 0;
    this.backoff.reset();
    this.pending = {};
    this.downSince = null;

    if (this.currentState !== 'idle') {
      this.setState('idle');
    }
  }

  notifyExternalEvent(ev: SupervisorExternalEvent): void {
    switch (ev) {
      case 'hass-reconnected':
      case 'page-resumed':
        this.handleConnectivityEvent(ev);
        break;
      case 'visibility-hidden':
        this.handleHidden();
        break;
      case 'visibility-visible':
        this.handleVisible();
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Attempt lifecycle                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Run one connection attempt: sign a fresh URL, build a player, mount it.
   *
   * Resolution happens per attempt on purpose — see the module docs. A failure
   * here (HA restarting, entity missing, signing refused) is a normal failed
   * attempt, not a special case: it feeds the same retry ladder, because those
   * failures happen exactly when retrying matters most.
   */
  private beginAttempt(): void {
    if (!this.started || this.suspended) return;

    const generation = ++this.generation;
    this.setState('connecting', {
      reason: this.pending.reason,
      attempt: this.pending.attempt,
      downForMs: this.downForMs(),
    });

    const hass = this.deps.getHass();
    if (!hass) {
      this.handleDeath('ws-error', 'Home Assistant is not available yet.');
      return;
    }
    const video = this.deps.getVideo();
    if (!video) {
      this.handleDeath('media-error', 'The video element is not ready yet.');
      return;
    }

    this.watchdog.attach(video);

    const config = this.deps.getConfig();
    void this.deps.endpoint.resolveSignedWsUrl(hass, config).then(
      (url) => {
        if (!this.isCurrent(generation)) return;
        this.mountPlayer(video, url, generation);
      },
      (error: unknown) => {
        if (!this.isCurrent(generation)) return;
        this.handleDeath('ws-error', describeError(error));
      },
    );
  }

  private mountPlayer(video: HTMLVideoElement, url: string, generation: number): void {
    let player: LivePlayer;
    try {
      player = this.deps.createPlayer();
    } catch (error) {
      this.handleDeath('media-error', describeError(error));
      return;
    }

    this.player = player;
    player.onPlaying = () => {
      if (this.isCurrent(generation)) this.handlePlaying();
    };
    player.onDead = (reason: DeathReason) => {
      if (this.isCurrent(generation)) this.handleDeath(reason);
    };

    try {
      player.mount(video, url);
    } catch (error) {
      this.handleDeath('media-error', describeError(error));
    }
  }

  /** First frame presented: the stream is good again. */
  private handlePlaying(): void {
    if (this.currentState === 'playing') return;

    this.retryTimer.cancel();
    this.escapeTimer.cancel();
    this.tier1Attempts = 0;
    this.remountAttempts = 0;
    this.backoff.reset();
    this.pending = {};
    this.downSince = null;

    // Order matters: clear the held verdict *then* arm, so a watchdog that
    // convicted the previous player starts clean.
    this.watchdog.reset();
    this.setState('playing');
    this.watchdog.arm();
  }

  /**
   * The single entry point for every death: WS close/error, media error,
   * handshake timeout, watchdog stall, and the synthesised lifecycle reasons.
   */
  private handleDeath(reason: DeathReason, message?: string): void {
    if (!this.started || this.suspended) return;

    this.teardownPlayer();
    this.watchdog.disarm();
    this.watchdog.reset();
    this.markDown();

    const downForMs = this.downForMs();
    let state: SupervisorState;
    let attempt: number;
    let delayMs: number;

    if (this.tier1Attempts < TIER1_MAX_RETRIES) {
      // Tier 1: fast in-place retry.
      this.tier1Attempts += 1;
      state = 'retrying';
      attempt = this.tier1Attempts;
      delayMs = TIER1_RETRY_DELAY_MS;
    } else {
      // Tier 2: replace the whole player, on jittered exponential backoff.
      this.remountAttempts += 1;
      state = 'remounting';
      attempt = this.remountAttempts;
      delayMs = this.backoff.next();
    }

    this.log.info(
      `${LOG_PREFIX} stream died: ${reason}, ` +
        `${state === 'retrying' ? 'tier-1 retry' : 'tier-2 remount'} ${attempt} ` +
        `in ${delayMs} ms (down for ${Math.round(downForMs / 1000)} s)` +
        (message ? `: ${message}` : ''),
    );

    this.pending = { reason, attempt, message };
    this.setState(state, { reason, attempt, delayMs, downForMs, message });
    this.retryTimer.schedule(delayMs, () => this.beginAttempt());
  }

  /**
   * The watchdog convicted the stream. The player is a zombie (socket open,
   * no frames), so it is torn down first — `handleDeath` does that — and the
   * watchdog's held verdict is cleared as part of the same teardown.
   */
  private handleStall(): void {
    this.handleDeath('stall');
  }

  /** Destroy the current player and invalidate its callbacks. */
  private teardownPlayer(): void {
    this.generation += 1;
    const player = this.player;
    this.player = null;
    if (!player) return;
    player.onPlaying = () => {};
    player.onDead = () => {};
    try {
      player.destroy();
    } catch (error) {
      this.log.info(`${LOG_PREFIX} player teardown threw: ${describeError(error)}`);
    }
  }

  private isCurrent(generation: number): boolean {
    return this.started && !this.suspended && generation === this.generation;
  }

  /* ------------------------------------------------------------------ */
  /* External events                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * `hass-reconnected` / `page-resumed`: the network demonstrably just came
   * back, so there is no reason to sit out the rest of a backoff — and a tab
   * that was frozen never ran the pending timer anyway.
   *
   * The event means "try again *now*", never "forget the failures". Only a
   * successful attempt ({@link StreamSupervisorImpl.handlePlaying}) rewinds the
   * ladder: an HA socket that flaps every 15 s while go2rtc is genuinely down
   * would otherwise pin tier 2 at its 5 s base forever, hammering a recovering
   * server instead of backing off toward the cap. So the escalation survives
   * the event — if the immediate attempt also fails, the next delay picks up
   * where the ladder left off.
   *
   * While `playing` this is deliberately a no-op: the stream either still has
   * frames (nothing to do) or does not, in which case the watchdog convicts it
   * within 10 s. Reconnecting a healthy stream on every websocket blip is churn.
   * With nothing pending (mid-attempt, or `idle`) there is likewise nothing to
   * do, and no state — backoff included — is touched.
   */
  private handleConnectivityEvent(ev: 'hass-reconnected' | 'page-resumed'): void {
    if (!this.started || this.suspended) return;

    if (this.currentState === 'playing') {
      this.log.info(`${LOG_PREFIX} ${ev} while playing; letting the watchdog verify frames`);
      return;
    }

    if (this.retryTimer.pending) {
      this.log.info(`${LOG_PREFIX} ${ev}: retrying immediately`);
      this.pending = { ...this.pending, reason: ev };
      this.retryTimer.advance();
    }
  }

  /** Hidden: start the grace period. Nothing is torn down yet. */
  private handleHidden(): void {
    if (!this.started || this.suspended) return;
    if (this.hiddenTimer.pending) return;
    this.hiddenTimer.schedule(HIDDEN_TEARDOWN_GRACE_MS, () => this.suspend());
  }

  /** Visible: cancel the grace period, and reconnect if we already tore down. */
  private handleVisible(): void {
    this.hiddenTimer.cancel();
    if (!this.started || !this.suspended) return;

    this.suspended = false;
    this.tier1Attempts = 0;
    this.remountAttempts = 0;
    this.backoff.reset();
    this.pending = {};
    this.markDown();
    this.beginAttempt();
  }

  /**
   * Hidden long enough: release the socket and the decoder.
   *
   * Parking state is `idle` — no player, no timers, nothing being attempted, so
   * every other public state would be a lie to the card. `stop()` is
   * distinguished internally by `started`, and the detail message says why.
   * The downtime clock is cleared too: the stream is down *by request*, and
   * page-reloading a dashboard that has merely been hidden overnight would be
   * both useless (hidden tabs cannot reload usefully) and surprising.
   */
  private suspend(): void {
    if (!this.started || this.suspended) return;
    this.suspended = true;

    this.retryTimer.cancel();
    this.escapeTimer.cancel();
    this.teardownPlayer();
    this.watchdog.disarm();
    this.watchdog.reset();
    this.downSince = null;
    this.pending = {};

    this.log.info(`${LOG_PREFIX} dashboard hidden; stream torn down until it is visible again`);
    this.setState('idle', { message: 'Paused while the dashboard is hidden.' });
  }

  /* ------------------------------------------------------------------ */
  /* Downtime + escape hatch                                             */
  /* ------------------------------------------------------------------ */

  /** Start (or continue) the downtime clock, arming the escape hatch once. */
  private markDown(): void {
    if (this.downSince !== null) return;
    this.downSince = this.now();

    const minutes = this.deps.getConfig().reload_after_minutes_down ?? 0;
    if (!Number.isFinite(minutes) || minutes <= 0) return;

    this.escapeTimer.schedule(minutes * 60_000, () => this.triggerReload(minutes));
  }

  private triggerReload(minutes: number): void {
    this.log.info(
      `${LOG_PREFIX} stream down for ${minutes} minute(s); reloading the page (escape hatch)`,
    );
    this.reloadPage();
  }

  private downForMs(): number {
    return this.downSince === null ? 0 : Math.max(0, this.now() - this.downSince);
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  private setState(state: SupervisorState, detail?: SupervisorStateDetail): void {
    this.currentState = state;
    this.onStateChange(state, detail);
  }
}
