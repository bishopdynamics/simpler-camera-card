/**
 * `player/webrtc-player.ts` — the opt-in low-latency transport. Implements
 * {@link LivePlayer} (see `types.ts`), exactly like `mse-player.ts`, so the
 * supervisor drives both through the same one-shot contract.
 *
 * The handshake, in order:
 *
 * 1. `mount()` creates an `RTCPeerConnection` with **no ICE servers** (LAN-first
 *    per the spec: the browser and Frigate are on the same network, so a STUN
 *    round-trip only adds latency and a failure mode), adds `recvonly` video and
 *    audio transceivers, and opens a {@link Go2rtcClient} on the freshly signed
 *    URL it was handed — the *same* client the MSE player uses, on its JSON
 *    lane. There is no second socket and no second auth path.
 * 2. The local offer is sent as `{ type: 'webrtc/offer', value: '<sdp>' }`. The
 *    client queues it if the socket has not opened yet, so offer creation and
 *    socket opening may finish in either order.
 * 3. go2rtc replies `{ type: 'webrtc/answer', value: '<sdp>' }`, which is applied
 *    as the remote description.
 * 4. ICE candidates trickle both ways as
 *    `{ type: 'webrtc/candidate', value: '<candidate>' }`. go2rtc sends the
 *    candidate *string* only — no `sdpMid` / `sdpMLineIndex` — so
 *    {@link REMOTE_CANDIDATE_SDP_MID} is supplied locally, matching upstream
 *    `video-rtc.js`.
 * 5. The first `track` event's stream is attached to the element via `srcObject`
 *    and `play()` is called (retried muted on rejection, like the MSE player).
 *
 * Deliberate differences from upstream `video-rtc.js`:
 *
 * - **The signalling socket stays open.** Upstream closes it the moment the peer
 *   connection connects (it races transports over one socket and drops the
 *   loser); go2rtc keeps the peer connection alive either way. Keeping it open
 *   costs nothing and buys one more failure detector: a socket that closes under
 *   us means go2rtc went away, which is worth a remount even if frames are
 *   momentarily still arriving. See {@link WebRtcPlayer} for the trade-off.
 * - **`disconnected` is not a death.** Upstream tears down and reconnects on
 *   `disconnected`; the spec's rule is that only `failed` is terminal, because
 *   `disconnected` usually self-heals and the watchdog convicts within 10 s if
 *   it does not. Treating it as fatal turns a blip into reconnect churn.
 * - **No internal recovery.** Every failure funnels into `onDead(reason)` exactly
 *   once and the supervisor decides what happens next.
 */

import { HANDSHAKE_TIMEOUT_MS, type DeathReason, type LivePlayer } from '../types';
import { Go2rtcClient, type Go2rtcMessage, type WebSocketConstructor } from './go2rtc-client';

const LOG_PREFIX = '[simpler-camera-card]';

/**
 * ICE servers offered to the peer connection: none.
 *
 * The card's whole premise is a browser with direct LAN access to the Frigate
 * box, where host candidates connect immediately. A STUN server would add a
 * round-trip to every connection attempt and a dependency on the internet being
 * up for a stream that never leaves the LAN. Making this configurable is a
 * deliberate deferral (see `docs/DEFERRED.md`), not an oversight.
 */
export const ICE_SERVERS: readonly RTCIceServer[] = [];

/**
 * `sdpMid` supplied for go2rtc's remote candidates.
 *
 * go2rtc sends bare candidate strings (`{"type":"webrtc/candidate","value":
 * "candidate:… udp …"}`), but `addIceCandidate` requires a media identifier.
 * Upstream `video-rtc.js` hardcodes `'0'` — the first m-line, which is the video
 * transceiver added first below — and go2rtc bundles everything on one transport.
 */
export const REMOTE_CANDIDATE_SDP_MID = '0';

/**
 * Cap on remote candidates buffered while the answer is still being applied.
 *
 * Unlike the client's outbound queue this one is fed by the network, so it is
 * bounded on principle. A real session trickles a handful of candidates; well
 * before this cap the overflow is noise, and dropping it costs nothing because
 * ICE only needs one candidate pair to succeed.
 */
export const MAX_PENDING_REMOTE_CANDIDATES = 64;

/** `RTCPeerConnection`, as a value: injectable so tests can substitute a stub. */
export type PeerConnectionConstructor = new (configuration?: RTCConfiguration) => RTCPeerConnection;

export interface WebRtcPlayerOptions {
  /** Defaults to `globalThis.WebSocket` (passed through to the client). */
  webSocketImpl?: WebSocketConstructor;
  /** Defaults to `globalThis.RTCPeerConnection`. */
  peerConnectionImpl?: PeerConnectionConstructor;
}

/** `idle` → `live` → `finished` (dead **or** destroyed); never goes back. */
type PlayerState = 'idle' | 'live' | 'finished';

/**
 * A single WebRTC playback attempt.
 *
 * Constructed by the card's `PlayerFactory`, driven only by the supervisor:
 * assign `onPlaying`/`onDead`, call `mount()` once, call `destroy()` when done
 * with it.
 *
 * **Death mapping** (every one of these funnels through {@link WebRtcPlayer.die}
 * exactly once):
 *
 * | Failure                                            | Reason              |
 * | -------------------------------------------------- | ------------------- |
 * | signalling socket closed (even after media flows)   | `ws-close`          |
 * | signalling socket errored                           | `ws-error`          |
 * | go2rtc JSON `error` message                         | `ws-error`          |
 * | missing / malformed `webrtc/answer`                 | `ws-error`          |
 * | `connectionState`/`iceConnectionState` `failed`     | `ws-error`          |
 * | `<video>` element `error`                           | `media-error`       |
 * | no presented frame within `HANDSHAKE_TIMEOUT_MS`    | `handshake-timeout` |
 *
 * ICE `failed` maps to `ws-error` rather than `media-error` because it is a
 * connection failure, not a decode failure: the transport never came up (or was
 * lost), which is precisely what the `ws-*` family means to the supervisor —
 * and, unlike a media error, it is not a property of the element being reused.
 *
 * A socket close after the peer connection is up is *also* fatal here. go2rtc
 * does not close the signalling socket on its own (upstream's client is what
 * closes it, when it races transports), so a close means go2rtc restarted or the
 * path to it broke — under which a peer connection that still looks connected is
 * living on borrowed time. Remounting is cheap; a silently dying stream on a
 * wall dashboard is not. If this proves too conservative in the field, the fix
 * is to demote it to "ignore once media is flowing" and let the watchdog convict.
 */
export class WebRtcPlayer implements LivePlayer {
  onPlaying: () => void = () => {};
  onDead: (reason: DeathReason) => void = () => {};

  private readonly options: WebRtcPlayerOptions;

  private state: PlayerState = 'idle';
  private video: HTMLVideoElement | null = null;
  private client: Go2rtcClient | null = null;
  private pc: RTCPeerConnection | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set when a `webrtc/answer` has been accepted (before it is applied). */
  private answerSeen = false;
  /** Set once `setRemoteDescription` has resolved; gates `addIceCandidate`. */
  private remoteDescriptionApplied = false;
  /** Remote candidates that arrived before the answer was applied. */
  private pendingCandidates: string[] = [];

  /** Stream assembled from `track` events when go2rtc supplies no stream. */
  private assembledStream: MediaStream | null = null;
  /** `play()` is called on the first attached track only. */
  private playbackRequested = false;

  /** Set once playback has genuinely advanced (see `checkPlaybackAdvanced`). */
  private playing = false;
  /** Previous `timeupdate` position, used to detect *advancing* playback. */
  private lastTime: number | null = null;

  private readonly handleVideoError = () => {
    const error = this.video?.error;
    this.die('media-error', error ? `<video> error ${error.code}: ${error.message}` : undefined);
  };
  private readonly handleTimeUpdate = () => this.checkPlaybackAdvanced();
  private readonly handleTrack = (event: Event) => this.attachTrack(event as RTCTrackEvent);
  private readonly handleIceCandidate = (event: Event) =>
    this.sendLocalCandidate(event as RTCPeerConnectionIceEvent);
  private readonly handleConnectionStateChange = () =>
    this.checkConnectionState('connectionState', this.pc?.connectionState);
  private readonly handleIceConnectionStateChange = () =>
    this.checkConnectionState('iceConnectionState', this.pc?.iceConnectionState);

  constructor(options: WebRtcPlayerOptions = {}) {
    this.options = options;
  }

  mount(video: HTMLVideoElement, signedWsUrl: string): void {
    if (this.state !== 'idle') {
      console.info(`${LOG_PREFIX} WebRTC player mount() ignored: player is ${this.state}`);
      return;
    }
    this.state = 'live';
    this.video = video;
    video.addEventListener('error', this.handleVideoError);
    video.addEventListener('timeupdate', this.handleTimeUpdate);

    // Runs from mount() until the first frame is actually presented. Identical
    // rule to the MSE player, and for the same reason: a peer connection that
    // reaches `connected` without ever presenting a frame is the silent failure
    // this timer exists for, and no WebRTC event reports it.
    this.handshakeTimer = setTimeout(() => this.die('handshake-timeout'), HANDSHAKE_TIMEOUT_MS);

    const peerConnectionImpl =
      this.options.peerConnectionImpl ??
      (globalThis as { RTCPeerConnection?: PeerConnectionConstructor }).RTCPeerConnection;
    if (!peerConnectionImpl) {
      this.die('media-error', 'WebRTC is unavailable in this browser');
      return;
    }
    if (!this.createPeerConnection(peerConnectionImpl)) return;

    const client = new Go2rtcClient(signedWsUrl, { webSocketImpl: this.options.webSocketImpl });
    this.client = client;
    client.onClose = (code, reason) =>
      this.die('ws-close', `code ${code}${reason ? ` (${reason})` : ''}`);
    client.onError = () => this.die('ws-error');
    client.on('webrtc/answer', (message) => void this.applyAnswer(message));
    client.on('webrtc/candidate', (message) => this.receiveRemoteCandidate(message));
    // go2rtc reports protocol-level problems ("stream not found", producer
    // failures) as a JSON error on the signalling socket.
    client.on('error', (message) => this.die('ws-error', `go2rtc: ${String(message.value)}`));
    client.connect();

    void this.sendOffer();
  }

  destroy(): void {
    this.state = 'finished';
    this.teardown();
  }

  /* ------------------------------------------------------------------ */
  /* Signalling                                                          */
  /* ------------------------------------------------------------------ */

  /** Build the peer connection and its `recvonly` transceivers. */
  private createPeerConnection(peerConnectionImpl: PeerConnectionConstructor): boolean {
    let pc: RTCPeerConnection;
    try {
      pc = new peerConnectionImpl({ iceServers: [...ICE_SERVERS] });
    } catch (error) {
      this.die('media-error', `RTCPeerConnection could not be created: ${describe(error)}`);
      return false;
    }
    this.pc = pc;
    pc.addEventListener('track', this.handleTrack);
    pc.addEventListener('icecandidate', this.handleIceCandidate);
    pc.addEventListener('connectionstatechange', this.handleConnectionStateChange);
    pc.addEventListener('iceconnectionstatechange', this.handleIceConnectionStateChange);

    try {
      // Explicit transceivers rather than `offerToReceive*`: the latter is
      // deprecated and unimplemented on Safari. Video first, so the m-line
      // index REMOTE_CANDIDATE_SDP_MID names is the video one.
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
    } catch (error) {
      this.die('media-error', `addTransceiver failed: ${describe(error)}`);
      return false;
    }
    return true;
  }

  /** Create the local offer and hand it to go2rtc. */
  private async sendOffer(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.state !== 'live') return;

    let sdp: string;
    try {
      const offer = await pc.createOffer();
      if (this.state !== 'live') return;
      await pc.setLocalDescription(offer);
      if (this.state !== 'live') return;
      sdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
    } catch (error) {
      this.die('ws-error', `WebRTC offer could not be created: ${describe(error)}`);
      return;
    }
    if (sdp === '') {
      this.die('ws-error', 'WebRTC offer carried no SDP');
      return;
    }

    console.info(`${LOG_PREFIX} WebRTC offer sent (${sdp.length} bytes of SDP)`);
    this.client?.send({ type: 'webrtc/offer', value: sdp });
  }

  /** go2rtc's `webrtc/answer` carries the remote SDP as a bare string. */
  private async applyAnswer(message: Go2rtcMessage): Promise<void> {
    if (this.state !== 'live') return;
    const pc = this.pc;
    if (!pc) return;
    if (this.answerSeen) {
      // A second answer would renegotiate a session that is already up; the
      // first one won.
      console.info(`${LOG_PREFIX} ignoring a duplicate webrtc/answer`);
      return;
    }

    const sdp = typeof message.value === 'string' ? message.value : '';
    if (sdp === '') {
      this.die('ws-error', 'go2rtc sent a webrtc/answer with no SDP');
      return;
    }
    this.answerSeen = true;

    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (error) {
      // A rejected answer is a broken handshake, not a media failure.
      this.die('ws-error', `webrtc/answer rejected: ${describe(error)}`);
      return;
    }
    if (this.state !== 'live') return;

    console.info(`${LOG_PREFIX} WebRTC answer applied`);
    this.remoteDescriptionApplied = true;
    this.flushPendingCandidates();
  }

  /**
   * A remote ICE candidate.
   *
   * Candidates that arrive before the answer has been applied are buffered:
   * `addIceCandidate` throws without a remote description, and while go2rtc
   * answers before it trickles, `setRemoteDescription` is asynchronous — a
   * candidate can always land in that window.
   *
   * An empty `value` is go2rtc's optional end-of-candidates marker (documented
   * as "empty value also allowed"); there is nothing to add for it.
   */
  private receiveRemoteCandidate(message: Go2rtcMessage): void {
    if (this.state !== 'live') return;
    const candidate = typeof message.value === 'string' ? message.value : '';
    if (candidate === '') return;

    if (!this.remoteDescriptionApplied) {
      if (this.pendingCandidates.length >= MAX_PENDING_REMOTE_CANDIDATES) {
        console.info(`${LOG_PREFIX} dropping a remote ICE candidate: buffer full`);
        return;
      }
      this.pendingCandidates.push(candidate);
      return;
    }
    void this.addRemoteCandidate(candidate);
  }

  private flushPendingCandidates(): void {
    const candidates = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of candidates) {
      void this.addRemoteCandidate(candidate);
    }
  }

  private async addRemoteCandidate(candidate: string): Promise<void> {
    if (this.state !== 'live') return;
    try {
      await this.pc?.addIceCandidate({ candidate, sdpMid: REMOTE_CANDIDATE_SDP_MID });
    } catch (error) {
      // Never fatal: ICE needs one working pair, and a connection that ends up
      // with none reports `failed`, which is what actually kills the player.
      console.info(`${LOG_PREFIX} ignoring an unusable remote ICE candidate:`, error);
    }
  }

  /** Trickle a local candidate back to go2rtc on the signalling lane. */
  private sendLocalCandidate(event: RTCPeerConnectionIceEvent): void {
    if (this.state !== 'live') return;
    const candidate = event.candidate?.candidate;
    // A null candidate is "gathering complete"; go2rtc needs no marker for it.
    if (!candidate) return;
    this.client?.send({ type: 'webrtc/candidate', value: candidate });
  }

  /* ------------------------------------------------------------------ */
  /* Media flow                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Attach the incoming media to the element.
   *
   * go2rtc puts every track in one stream, so the usual path is "use
   * `event.streams[0]`". When a stream is absent (Firefox has shipped this, and
   * so do several fakes) the tracks are assembled into a stream of our own.
   */
  private attachTrack(event: RTCTrackEvent): void {
    if (this.state !== 'live') return;
    const video = this.video;
    if (!video) return;

    const stream = event.streams?.[0] ?? this.assemble(event.track);
    if (!stream) return;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      console.info(`${LOG_PREFIX} WebRTC media attached (${event.track?.kind ?? 'unknown'} track)`);
    }
    if (this.playbackRequested) return;
    this.playbackRequested = true;
    this.startPlayback();
  }

  /** Collect tracks into one locally-owned `MediaStream`. */
  private assemble(track: MediaStreamTrack | undefined): MediaStream | null {
    if (!track) return null;
    const streamImpl = (globalThis as { MediaStream?: new () => MediaStream }).MediaStream;
    if (!streamImpl) {
      console.info(`${LOG_PREFIX} no MediaStream constructor: cannot attach a track without one`);
      return null;
    }
    if (!this.assembledStream) this.assembledStream = new streamImpl();
    this.assembledStream.addTrack(track);
    return this.assembledStream;
  }

  /**
   * Always call `play()` — see `mse-player.ts`: the card this one replaces
   * gutted it, which is root cause #1 of its never-recovering streams. On
   * rejection, mute and try once more; v1 is muted anyway.
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
   * greater than the previous one — the same rule as the MSE player, for the
   * same reason: `playing`/`loadeddata` report intent, not a presented frame,
   * and a peer connection that connects but never decodes would otherwise look
   * healthy.
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
    console.info(`${LOG_PREFIX} WebRTC playback started`);
    this.onPlaying();
  }

  /* ------------------------------------------------------------------ */
  /* Connection state                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * The spec's rule, exactly: only `failed` is terminal.
   *
   * `disconnected` is a transient ICE verdict that usually self-heals within a
   * couple of seconds (a Wi-Fi blip, a NAT rebind). Tearing down on it turns
   * every blip into a full remount; the ones that *don't* heal stop producing
   * frames, and the supervisor's watchdog convicts them within 10 s. It is
   * logged so the transition is visible when debugging in the field.
   */
  private checkConnectionState(label: string, state: string | undefined): void {
    if (this.state !== 'live' || !state) return;
    if (state === 'failed') {
      this.die('ws-error', `${label} failed`);
      return;
    }
    if (state === 'disconnected') {
      console.info(
        `${LOG_PREFIX} WebRTC ${label} disconnected — not fatal; ` +
          `the watchdog convicts if frames stop`,
      );
      return;
    }
    console.info(`${LOG_PREFIX} WebRTC ${label}: ${state}`);
  }

  /* ------------------------------------------------------------------ */
  /* Death and teardown                                                  */
  /* ------------------------------------------------------------------ */

  /** Fire-once death: tear everything down, then report the reason. */
  private die(reason: DeathReason, detail?: string): void {
    if (this.state === 'finished') return;
    this.state = 'finished';
    console.info(`${LOG_PREFIX} WebRTC player died: ${reason}${detail ? ` — ${detail}` : ''}`);
    this.teardown();
    this.onDead(reason);
  }

  /** Idempotent, best-effort release of every resource this player took. */
  private teardown(): void {
    this.clearHandshakeTimer();
    this.pendingCandidates = [];

    this.client?.close();
    this.client = null;

    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.removeEventListener('track', this.handleTrack);
      pc.removeEventListener('icecandidate', this.handleIceCandidate);
      pc.removeEventListener('connectionstatechange', this.handleConnectionStateChange);
      pc.removeEventListener('iceconnectionstatechange', this.handleIceConnectionStateChange);
      // Stopping the transceivers first tells the far end the session is over;
      // `stop()` is absent on older engines and throws on a closing connection,
      // and neither matters once `close()` lands.
      quietly(() => {
        for (const transceiver of pc.getTransceivers?.() ?? []) {
          quietly(() => transceiver.stop?.());
        }
      });
      quietly(() => pc.close());
    }

    this.assembledStream = null;

    const video = this.video;
    this.video = null;
    if (video) {
      video.removeEventListener('error', this.handleVideoError);
      video.removeEventListener('timeupdate', this.handleTimeUpdate);
      // Detach the media so the element stops holding decoder resources; the
      // supervisor reuses the same element for the next attempt.
      quietly(() => {
        video.srcObject = null;
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
