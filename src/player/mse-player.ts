/**
 * `player/mse-player.ts` — fMP4-over-WebSocket playback through Media Source
 * Extensions. Implements {@link LivePlayer} (see `types.ts`).
 *
 * The handshake, in order:
 *
 * 1. `mount()` creates a `MediaSource`, attaches it to the `<video>` element
 *    and opens a {@link Go2rtcClient} on the freshly signed URL it was handed.
 * 2. On `sourceopen` the player announces the codecs this browser can actually
 *    play (`MediaSource.isTypeSupported` over {@link MSE_CANDIDATE_CODECS}) as
 *    `{ type: 'mse', value: '<codec>,<codec>,…' }`. The client queues the
 *    message if the socket has not opened yet, so the two orderings converge.
 * 3. go2rtc replies `{ type: 'mse', value: 'video/mp4; codecs="…"' }`; that
 *    string is handed straight to `addSourceBuffer()`, and `video.play()` is
 *    called.
 * 4. Binary frames (fMP4 init segment, then `moof`+`mdat` fragments) are
 *    appended, with the buffer hygiene below applied on every `updateend`.
 *
 * **Buffer hygiene** — this is the part upstream `video-rtc.js` gets wrong, and
 * the reason this module exists rather than a vendored copy:
 *
 * - Segments arriving while the `SourceBuffer` is `updating` are staged in a
 *   **bounds-checked queue of discrete buffers**. Upstream copies them into a
 *   fixed 2 MB scratch buffer, which overflows (`RangeError: source array is
 *   too long`) into a permanent stall with a perfectly healthy WebSocket.
 * - `appendBuffer` exceptions (`QuotaExceededError`, …) are surfaced as
 *   `media-error`, never swallowed.
 * - The back-buffer is trimmed to {@link MAX_BACK_BUFFER_S}.
 * - More than {@link MAX_BUFFERED_AHEAD_S} buffered ahead of playback means the
 *   element is decoding slower than the stream arrives (the "slow motion"
 *   pathology); the stream is declared broken rather than drifting further.
 * - Falling more than {@link LIVE_EDGE_MAX_LAG_S} behind the live edge is fixed
 *   by **seeking** to the edge, never by chasing with `playbackRate` (which
 *   re-buffers on WebKit).
 *
 * The player is one-shot and owns no recovery: every failure funnels into
 * `onDead(reason)` exactly once, and the supervisor decides what happens next.
 * Stall detection is deliberately absent — the watchdog in `reliability/`
 * covers connected-but-frozen streams at the element level.
 */

import { HANDSHAKE_TIMEOUT_MS, type DeathReason, type LivePlayer } from '../types';
import { Go2rtcClient, type Go2rtcMessage, type WebSocketConstructor } from './go2rtc-client';

const LOG_PREFIX = '[simpler-camera-card]';

/**
 * Codecs offered to go2rtc, filtered by `MediaSource.isTypeSupported` before
 * they are sent. H.264 High profile covers everything Frigate produces by
 * default; H.265 needs Chrome 136+ and is simply filtered out elsewhere.
 * Audio codecs are offered even though v1 plays muted — the stream may be
 * multiplexed, and refusing its audio track would refuse the stream.
 */
export const MSE_CANDIDATE_CODECS: readonly string[] = [
  'avc1.640029', // H.264 High @ L4.1
  'avc1.64002A', // H.264 High @ L4.2
  'avc1.640033', // H.264 High @ L5.1
  'hvc1.1.6.L153.B0', // H.265 Main @ L5.1
  'mp4a.40.2', // AAC-LC
  'mp4a.40.5', // HE-AAC
  'flac',
  'opus',
];

/**
 * Staging-queue cap, in segments.
 *
 * A `SourceBuffer` update completes in single-digit milliseconds, so a healthy
 * stream stages at most one or two fragments at a time. Two hundred fMP4
 * fragments is several seconds of video: far beyond any legitimate transient,
 * and unambiguous evidence that the element has stopped draining.
 */
export const MAX_STAGED_SEGMENTS = 200;

/**
 * Staging-queue cap, in bytes (4 MB) — the same judgement expressed for
 * keyframe-heavy streams, where a handful of segments is already large.
 */
export const MAX_STAGED_BYTES = 4 * 1024 * 1024;

/** Keep at most this many seconds of already-played media in the buffer. */
export const MAX_BACK_BUFFER_S = 5;

/** More than this buffered ahead of playback ⇒ the stream is broken. */
export const MAX_BUFFERED_AHEAD_S = 10;

/** Falling more than this far behind the live edge triggers a jump to live. */
export const LIVE_EDGE_MAX_LAG_S = 2;

/**
 * Where a jump-to-live lands: this far behind the buffered end, rather than
 * exactly on it — seeking onto the edge itself stalls the element while it
 * waits for the next fragment.
 */
export const LIVE_EDGE_TARGET_LAG_S = 0.5;

/** `MediaSource`, as a value: injectable so tests can substitute a stub. */
export interface MediaSourceConstructor {
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
}

export interface MsePlayerOptions {
  /** Defaults to `globalThis.WebSocket`. */
  webSocketImpl?: WebSocketConstructor;
  /** Defaults to `globalThis.MediaSource`. */
  mediaSourceImpl?: MediaSourceConstructor;
}

/**
 * One fMP4 fragment staged for append. Pinned to a plain `ArrayBuffer` (rather
 * than `ArrayBufferLike`) so it satisfies `appendBuffer`'s `BufferSource`.
 */
type Segment = Uint8Array<ArrayBuffer>;

/** `idle` → `live` → `finished` (dead **or** destroyed); never goes back. */
type PlayerState = 'idle' | 'live' | 'finished';

/**
 * A single MSE playback attempt.
 *
 * Constructed by the card's `PlayerFactory`, driven only by the supervisor:
 * assign `onPlaying`/`onDead`, call `mount()` once, call `destroy()` when done
 * with it.
 */
export class MsePlayer implements LivePlayer {
  onPlaying: () => void = () => {};
  onDead: (reason: DeathReason) => void = () => {};

  private readonly options: MsePlayerOptions;

  private state: PlayerState = 'idle';
  private video: HTMLVideoElement | null = null;
  private client: Go2rtcClient | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Codec list offered to go2rtc; computed once in {@link MsePlayer.mount}. */
  private codecs = '';

  /** Segments awaiting an idle `SourceBuffer`, oldest first. */
  private staged: Segment[] = [];
  private stagedBytes = 0;

  /** Set once playback has genuinely advanced; gates the hygiene rules. */
  private playing = false;
  /** Previous `timeupdate` position, used to detect *advancing* playback. */
  private lastTime: number | null = null;

  private readonly handleVideoError = () => {
    const error = this.video?.error;
    this.die('media-error', error ? `<video> error ${error.code}: ${error.message}` : undefined);
  };
  private readonly handleTimeUpdate = () => this.checkPlaybackAdvanced();
  private readonly handleSourceOpen = () => this.requestMseLane();
  private readonly handleUpdateEnd = () => this.afterUpdate();
  private readonly handleSourceBufferError = () => this.die('media-error', 'SourceBuffer error');

  constructor(options: MsePlayerOptions = {}) {
    this.options = options;
  }

  mount(video: HTMLVideoElement, signedWsUrl: string): void {
    if (this.state !== 'idle') {
      console.info(`${LOG_PREFIX} MSE player mount() ignored: player is ${this.state}`);
      return;
    }
    this.state = 'live';
    this.video = video;
    video.addEventListener('error', this.handleVideoError);
    video.addEventListener('timeupdate', this.handleTimeUpdate);

    // Runs from mount() until the first frame is actually presented, i.e. until
    // `onPlaying`. `types.ts` defines this window as "no first frame within
    // this long after mount()", which is strictly stronger than "first segment
    // appended" — an attempt that appends media but never presents a frame is
    // exactly the silent failure this timer exists for.
    this.handshakeTimer = setTimeout(() => this.die('handshake-timeout'), HANDSHAKE_TIMEOUT_MS);

    const mediaSourceImpl =
      this.options.mediaSourceImpl ??
      (globalThis as { MediaSource?: MediaSourceConstructor }).MediaSource;
    if (!mediaSourceImpl) {
      this.die('media-error', 'MediaSource is unavailable in this browser');
      return;
    }

    const codecs = supportedCodecs(mediaSourceImpl);
    if (codecs === '') {
      this.die('media-error', 'no MSE codec offered by this browser is usable');
      return;
    }
    this.codecs = codecs;

    if (!this.attachMediaSource(mediaSourceImpl, video)) return;

    const client = new Go2rtcClient(signedWsUrl, { webSocketImpl: this.options.webSocketImpl });
    this.client = client;
    client.onBinary = (data) => this.handleSegment(data);
    client.onClose = (code, reason) =>
      this.die('ws-close', `code ${code}${reason ? ` (${reason})` : ''}`);
    client.onError = () => this.die('ws-error');
    client.on('mse', (message) => this.openSourceBuffer(message));
    // go2rtc reports protocol-level problems ("stream not found", producer
    // failures) as a JSON error on the same socket. It is a websocket-delivered
    // go2rtc failure, so it maps onto `ws-error`.
    client.on('error', (message) => this.die('ws-error', `go2rtc: ${String(message.value)}`));
    client.connect();
  }

  destroy(): void {
    this.state = 'finished';
    this.teardown();
  }

  /** Create the `MediaSource` and point the element at it. */
  private attachMediaSource(
    mediaSourceImpl: MediaSourceConstructor,
    video: HTMLVideoElement,
  ): boolean {
    let mediaSource: MediaSource;
    try {
      mediaSource = new mediaSourceImpl();
    } catch (error) {
      this.die('media-error', `MediaSource could not be created: ${describe(error)}`);
      return false;
    }
    this.mediaSource = mediaSource;
    mediaSource.addEventListener('sourceopen', this.handleSourceOpen, { once: true });

    try {
      this.objectUrl = URL.createObjectURL(mediaSource);
      video.src = this.objectUrl;
    } catch (error) {
      this.die('media-error', `MediaSource could not be attached: ${describe(error)}`);
      return false;
    }
    return true;
  }

  /** `sourceopen`: ask go2rtc for an MSE lane with the codecs we can play. */
  private requestMseLane(): void {
    if (this.state !== 'live') return;
    if (this.objectUrl) {
      // The element has already resolved the blob URL; holding it only leaks.
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.client?.send({ type: 'mse', value: this.codecs });
  }

  /** go2rtc's `mse` reply carries the exact mime type to open the buffer with. */
  private openSourceBuffer(message: Go2rtcMessage): void {
    if (this.state !== 'live') return;
    if (this.sourceBuffer) return; // duplicate reply; the first one won

    const mime = typeof message.value === 'string' ? message.value : '';
    if (mime === '') {
      this.die('media-error', 'go2rtc offered no MSE codec for this stream');
      return;
    }
    const mediaSource = this.mediaSource;
    if (!mediaSource || mediaSource.readyState !== 'open') {
      this.die('media-error', 'MediaSource closed before the MSE lane opened');
      return;
    }

    let sourceBuffer: SourceBuffer;
    try {
      sourceBuffer = mediaSource.addSourceBuffer(mime);
      // go2rtc sends independently timestamped fragments, not a sequence.
      sourceBuffer.mode = 'segments';
    } catch (error) {
      this.die('media-error', `addSourceBuffer("${mime}") failed: ${describe(error)}`);
      return;
    }
    sourceBuffer.addEventListener('updateend', this.handleUpdateEnd);
    sourceBuffer.addEventListener('error', this.handleSourceBufferError);
    this.sourceBuffer = sourceBuffer;

    this.startPlayback();
    this.flushStaged();
  }

  /* ------------------------------------------------------------------ */
  /* Media flow                                                          */
  /* ------------------------------------------------------------------ */

  private handleSegment(data: ArrayBuffer): void {
    if (this.state !== 'live') return;
    const segment = new Uint8Array(data);
    const sourceBuffer = this.sourceBuffer;
    // Preserve arrival order: anything already staged must go first.
    if (!sourceBuffer || sourceBuffer.updating || this.staged.length > 0) {
      this.stage(segment);
      return;
    }
    this.append(segment);
  }

  private stage(segment: Segment): void {
    this.staged.push(segment);
    this.stagedBytes += segment.byteLength;
    if (this.staged.length > MAX_STAGED_SEGMENTS || this.stagedBytes > MAX_STAGED_BYTES) {
      console.info(
        `${LOG_PREFIX} MSE staging queue overflowed ` +
          `(${this.staged.length} segments / ${this.stagedBytes} bytes): ` +
          `the SourceBuffer has stopped draining`,
      );
      this.die('media-error', 'staging queue overflow');
    }
  }

  /** Append every staged segment as one buffer, oldest first. */
  private flushStaged(): void {
    const sourceBuffer = this.sourceBuffer;
    if (this.state !== 'live' || !sourceBuffer || sourceBuffer.updating) return;
    if (this.staged.length === 0) return;

    const segments = this.staged;
    const total = this.stagedBytes;
    this.staged = [];
    this.stagedBytes = 0;

    if (segments.length === 1) {
      this.append(segments[0]);
      return;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const segment of segments) {
      merged.set(segment, offset);
      offset += segment.byteLength;
    }
    this.append(merged);
  }

  private append(segment: Segment): void {
    const sourceBuffer = this.sourceBuffer;
    if (!sourceBuffer) return;
    try {
      sourceBuffer.appendBuffer(segment);
    } catch (error) {
      // Never swallowed: a QuotaExceededError here is precisely the failure
      // that leaves upstream stalled forever on a live socket.
      console.info(`${LOG_PREFIX} appendBuffer failed:`, error);
      this.die('media-error', `appendBuffer failed: ${describe(error)}`);
    }
  }

  private afterUpdate(): void {
    if (this.state !== 'live') return;
    if (this.staged.length > 0) {
      // Drain first; hygiene runs on the `updateend` that follows.
      this.flushStaged();
      return;
    }
    this.runBufferHygiene();
  }

  private runBufferHygiene(): void {
    const sourceBuffer = this.sourceBuffer;
    const video = this.video;
    if (!sourceBuffer || !video || sourceBuffer.updating) return;

    const buffered = sourceBuffer.buffered;
    if (!buffered || buffered.length === 0) return;
    const start = buffered.start(0);
    const end = buffered.end(buffered.length - 1);

    // Before playback starts, `currentTime` is 0 while the media's own
    // timestamps can be arbitrarily large, so neither distance below is
    // meaningful yet.
    if (this.playing) {
      const ahead = end - video.currentTime;
      if (ahead > MAX_BUFFERED_AHEAD_S) {
        console.info(
          `${LOG_PREFIX} ${ahead.toFixed(1)}s buffered ahead of playback ` +
            `(limit ${MAX_BUFFERED_AHEAD_S}s): declaring the stream broken`,
        );
        this.die('media-error', 'buffered too far ahead of playback');
        return;
      }
      if (ahead > LIVE_EDGE_MAX_LAG_S && !video.seeking) {
        const target = end - LIVE_EDGE_TARGET_LAG_S;
        if (target > video.currentTime) {
          console.info(`${LOG_PREFIX} ${ahead.toFixed(1)}s behind the live edge: jumping to live`);
          video.currentTime = target;
        }
      }
    }

    const cutoff = video.currentTime - MAX_BACK_BUFFER_S;
    if (cutoff > start && this.mediaSource?.readyState === 'open') {
      try {
        sourceBuffer.remove(start, cutoff);
      } catch (error) {
        // A failed trim wastes memory but does not break playback.
        console.info(`${LOG_PREFIX} back-buffer trim failed:`, error);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Playback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Always call `play()` — the card this one replaces gutted it, and that is
   * root cause #1 of its never-recovering streams. On rejection, mute and try
   * once more: v1 is muted anyway, so autoplay policy is satisfied.
   */
  private startPlayback(): void {
    const video = this.video;
    if (!video) return;
    const attempt = video.play() as Promise<void> | undefined;
    if (!attempt || typeof attempt.catch !== 'function') return;
    attempt.catch((error: unknown) => {
      if (this.state !== 'live') return;
      console.info(`${LOG_PREFIX} play() rejected, retrying muted:`, error);
      video.muted = true;
      const retry = video.play() as Promise<void> | undefined;
      retry?.catch?.((retryError: unknown) => {
        if (this.state !== 'live') return;
        // Not fatal in itself: no frames will follow, so the handshake timer
        // (or the watchdog, later) is what actually declares this dead.
        console.info(`${LOG_PREFIX} muted play() also rejected:`, retryError);
      });
    });
  }

  /**
   * `onPlaying` fires on the first `timeupdate` whose `currentTime` is strictly
   * greater than the previous one. The `playing` event is not used: it fires
   * when the element *intends* to play, which on a starved MediaSource happens
   * without a frame ever being presented — the exact false positive the
   * handshake timeout exists to catch.
   */
  private checkPlaybackAdvanced(): void {
    if (this.state !== 'live' || !this.video) return;
    const now = this.video.currentTime;
    const previous = this.lastTime;
    this.lastTime = now;
    if (previous === null || now <= previous) return;

    if (this.playing) return;
    this.playing = true;
    this.clearHandshakeTimer();
    console.info(`${LOG_PREFIX} MSE playback started`);
    this.onPlaying();
  }

  /* ------------------------------------------------------------------ */
  /* Death and teardown                                                  */
  /* ------------------------------------------------------------------ */

  /** Fire-once death: tear everything down, then report the reason. */
  private die(reason: DeathReason, detail?: string): void {
    if (this.state === 'finished') return;
    this.state = 'finished';
    console.info(`${LOG_PREFIX} MSE player died: ${reason}${detail ? ` — ${detail}` : ''}`);
    this.teardown();
    this.onDead(reason);
  }

  /** Idempotent, best-effort release of every resource this player took. */
  private teardown(): void {
    this.clearHandshakeTimer();
    this.staged = [];
    this.stagedBytes = 0;

    this.client?.close();
    this.client = null;

    const sourceBuffer = this.sourceBuffer;
    this.sourceBuffer = null;
    const mediaSource = this.mediaSource;
    this.mediaSource = null;

    if (sourceBuffer) {
      sourceBuffer.removeEventListener('updateend', this.handleUpdateEnd);
      sourceBuffer.removeEventListener('error', this.handleSourceBufferError);
    }
    if (mediaSource) {
      mediaSource.removeEventListener('sourceopen', this.handleSourceOpen);
      if (mediaSource.readyState === 'open') {
        // Both throw readily (mid-update, wrong state); neither failure matters
        // once the element is detached below.
        quietly(() => sourceBuffer?.abort());
        quietly(() => sourceBuffer && mediaSource.removeSourceBuffer(sourceBuffer));
      }
    }

    if (this.objectUrl) {
      quietly(() => URL.revokeObjectURL(this.objectUrl as string));
      this.objectUrl = null;
    }

    const video = this.video;
    this.video = null;
    if (video) {
      video.removeEventListener('error', this.handleVideoError);
      video.removeEventListener('timeupdate', this.handleTimeUpdate);
      // Detach the media so the element stops holding decoder resources; the
      // supervisor reuses the same element for the next attempt.
      quietly(() => {
        video.removeAttribute('src');
        video.load();
      });
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }
}

/** The subset of {@link MSE_CANDIDATE_CODECS} this browser can decode. */
export function supportedCodecs(mediaSourceImpl: MediaSourceConstructor): string {
  return MSE_CANDIDATE_CODECS.filter((codec) => {
    try {
      return mediaSourceImpl.isTypeSupported(`video/mp4; codecs="${codec}"`);
    } catch {
      return false;
    }
  }).join(',');
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function quietly(action: () => void): void {
  try {
    action();
  } catch {
    // Teardown is best-effort by construction.
  }
}
