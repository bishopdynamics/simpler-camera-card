import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocketConstructor } from '../../src/player/go2rtc-client';
import {
  MAX_PENDING_REMOTE_CANDIDATES,
  REMOTE_CANDIDATE_SDP_MID,
  WebRtcPlayer,
  type PeerConnectionConstructor,
} from '../../src/player/webrtc-player';
import { HANDSHAKE_TIMEOUT_MS, type DeathReason } from '../../src/types';
import { FakeMediaStream, FakePeerConnection, FakeVideo, FakeWebSocket, fakeTrack } from './stubs';

const WS_URL = 'wss://ha.local/api/frigate/frigate/go2rtc/ws/api/ws?src=front_yard&authSig=sig';
const ANSWER_SDP = 'v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
const CANDIDATE = 'candidate:1 1 udp 2130706431 192.168.1.10 8555 typ host';

const webSocketImpl = FakeWebSocket as unknown as WebSocketConstructor;
const peerConnectionImpl = FakePeerConnection as unknown as PeerConnectionConstructor;

beforeEach(() => {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Let every pending microtask (offer creation, `setRemoteDescription`) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** A mounted player with its stubs and spied callbacks. */
function mountPlayer() {
  const player = new WebRtcPlayer({ webSocketImpl, peerConnectionImpl });
  const onPlaying = vi.fn();
  const onDead = vi.fn<(reason: DeathReason) => void>();
  player.onPlaying = onPlaying;
  player.onDead = onDead;
  const video = new FakeVideo();

  player.mount(video as unknown as HTMLVideoElement, WS_URL);

  return {
    player,
    video,
    onPlaying,
    onDead,
    get socket() {
      return FakeWebSocket.last();
    },
    get pc() {
      return FakePeerConnection.last();
    },
  };
}

/** A `MediaStream` as go2rtc delivers one: already carrying the tracks. */
function remoteStream(): MediaStream {
  return new FakeMediaStream() as unknown as MediaStream;
}

/** Open the socket, exchange offer/answer, and deliver the video track. */
async function handshake(
  harness: ReturnType<typeof mountPlayer>,
  stream: MediaStream = remoteStream(),
): Promise<MediaStream> {
  harness.socket.serverOpen();
  await flush();
  harness.socket.serverJson({ type: 'webrtc/answer', value: ANSWER_SDP });
  await flush();
  harness.pc.setConnectionState('connected');
  harness.pc.emitTrack(fakeTrack('video'), [stream]);
  return stream;
}

/** Two advancing `timeupdate`s — what the player treats as "really playing". */
function startPlayback(video: FakeVideo, from = 10): void {
  video.advanceTo(from);
  video.advanceTo(from + 0.25);
}

describe('handshake', () => {
  it('opens the signed socket and a LAN-only peer connection', () => {
    const harness = mountPlayer();

    expect(harness.socket.url).toBe(WS_URL);
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(harness.pc.configuration).toEqual({ iceServers: [] });
  });

  it('offers recvonly video and audio transceivers, video first', () => {
    const harness = mountPlayer();

    expect(harness.pc.transceivers.map((t) => [t.kind, t.direction])).toEqual([
      ['video', 'recvonly'],
      ['audio', 'recvonly'],
    ]);
  });

  it('sends the local SDP as webrtc/offer', async () => {
    const harness = mountPlayer();
    harness.socket.serverOpen();

    await flush();

    expect(harness.socket.sentMessages).toEqual([
      { type: 'webrtc/offer', value: FakePeerConnection.offerSdp },
    ]);
    expect(harness.pc.localDescription?.type).toBe('offer');
  });

  it('tolerates the offer being ready before the socket opens', async () => {
    const harness = mountPlayer();

    await flush();
    expect(harness.socket.sent).toEqual([]); // queued by the client
    harness.socket.serverOpen();

    expect(harness.socket.sentMessages).toEqual([
      { type: 'webrtc/offer', value: FakePeerConnection.offerSdp },
    ]);
  });

  it("applies go2rtc's answer as the remote description", async () => {
    const harness = mountPlayer();
    harness.socket.serverOpen();
    await flush();

    harness.socket.serverJson({ type: 'webrtc/answer', value: ANSWER_SDP });
    await flush();

    expect(harness.pc.remoteDescription).toEqual({ type: 'answer', sdp: ANSWER_SDP });
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('ignores a second answer', async () => {
    const harness = mountPlayer();
    await handshake(harness);

    harness.socket.serverJson({ type: 'webrtc/answer', value: 'v=0\r\nsecond\r\n' });
    await flush();

    expect(harness.pc.remoteDescription?.sdp).toBe(ANSWER_SDP);
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('ignores a second mount()', () => {
    const harness = mountPlayer();
    harness.player.mount(new FakeVideo() as unknown as HTMLVideoElement, WS_URL);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakePeerConnection.instances).toHaveLength(1);
  });

  it('dies when the browser has no WebRTC at all', () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    const player = new WebRtcPlayer({ webSocketImpl });
    const onDead = vi.fn<(reason: DeathReason) => void>();
    player.onDead = onDead;

    player.mount(new FakeVideo() as unknown as HTMLVideoElement, WS_URL);

    expect(onDead).toHaveBeenCalledExactlyOnceWith('media-error');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe('ICE candidates', () => {
  it('adds remote candidates with the sdpMid go2rtc omits', async () => {
    const harness = mountPlayer();
    await handshake(harness);

    harness.socket.serverJson({ type: 'webrtc/candidate', value: CANDIDATE });
    await flush();

    expect(harness.pc.addedCandidates).toEqual([
      { candidate: CANDIDATE, sdpMid: REMOTE_CANDIDATE_SDP_MID },
    ]);
  });

  it('buffers candidates that arrive before the answer, then adds them in order', async () => {
    const harness = mountPlayer();
    harness.socket.serverOpen();
    await flush();

    // Before the answer message at all…
    harness.socket.serverJson({ type: 'webrtc/candidate', value: `${CANDIDATE} 1` });
    // …and inside the window where `setRemoteDescription` has not resolved yet.
    harness.socket.serverJson({ type: 'webrtc/answer', value: ANSWER_SDP });
    harness.socket.serverJson({ type: 'webrtc/candidate', value: `${CANDIDATE} 2` });
    expect(harness.pc.addedCandidates).toEqual([]);

    await flush();

    expect(harness.pc.addedCandidates.map((c) => c.candidate)).toEqual([
      `${CANDIDATE} 1`,
      `${CANDIDATE} 2`,
    ]);
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('bounds the pre-answer candidate buffer', async () => {
    const harness = mountPlayer();
    harness.socket.serverOpen();
    await flush();

    for (let i = 0; i < MAX_PENDING_REMOTE_CANDIDATES + 10; i += 1) {
      harness.socket.serverJson({ type: 'webrtc/candidate', value: `${CANDIDATE} ${i}` });
    }
    harness.socket.serverJson({ type: 'webrtc/answer', value: ANSWER_SDP });
    await flush();

    expect(harness.pc.addedCandidates).toHaveLength(MAX_PENDING_REMOTE_CANDIDATES);
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it("ignores go2rtc's empty end-of-candidates marker", async () => {
    const harness = mountPlayer();
    await handshake(harness);

    harness.socket.serverJson({ type: 'webrtc/candidate', value: '' });
    await flush();

    expect(harness.pc.addedCandidates).toEqual([]);
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('survives a candidate the browser refuses', async () => {
    const harness = mountPlayer();
    await handshake(harness);
    harness.pc.addIceCandidateError = new Error('OperationError');

    harness.socket.serverJson({ type: 'webrtc/candidate', value: CANDIDATE });
    await flush();

    // ICE only needs one working pair; a bad candidate is not a death.
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('trickles local candidates back on the signalling lane', async () => {
    const harness = mountPlayer();
    await handshake(harness);

    harness.pc.emitIceCandidate(CANDIDATE);
    harness.pc.emitIceCandidate(null); // gathering complete: nothing to send

    expect(harness.socket.sentMessages.slice(1)).toEqual([
      { type: 'webrtc/candidate', value: CANDIDATE },
    ]);
  });

  it('sends no local candidate after the player is finished', async () => {
    const harness = mountPlayer();
    await handshake(harness);
    const socket = harness.socket;
    const pc = harness.pc;
    harness.player.destroy();

    pc.emitIceCandidate(CANDIDATE);

    expect(socket.sentMessages.some((m) => m.type === 'webrtc/candidate')).toBe(false);
  });
});

describe('media', () => {
  it("attaches go2rtc's stream and starts playback exactly once", async () => {
    const harness = mountPlayer();
    const stream = await handshake(harness);

    harness.pc.emitTrack(fakeTrack('audio'), [stream]);

    expect(harness.video.srcObject).toBe(stream);
    expect(harness.video.play).toHaveBeenCalledTimes(1);
  });

  it('assembles a stream itself when the track event carries none', async () => {
    vi.stubGlobal('MediaStream', FakeMediaStream);
    const harness = mountPlayer();
    harness.socket.serverOpen();
    await flush();
    harness.socket.serverJson({ type: 'webrtc/answer', value: ANSWER_SDP });
    await flush();

    harness.pc.emitTrack(fakeTrack('video'), []);
    harness.pc.emitTrack(fakeTrack('audio'), []);

    const assembled = harness.video.srcObject as unknown as FakeMediaStream;
    expect(assembled).toBeInstanceOf(FakeMediaStream);
    expect(assembled.tracks.map((t) => t.kind)).toEqual(['video', 'audio']);
    expect(harness.video.play).toHaveBeenCalledTimes(1);
  });

  it('reports playing on the first advancing timeupdate, once', async () => {
    const harness = mountPlayer();
    await handshake(harness);

    harness.video.advanceTo(10);
    expect(harness.onPlaying).not.toHaveBeenCalled(); // nothing to compare against

    harness.video.advanceTo(10.25);
    harness.video.advanceTo(10.5);

    expect(harness.onPlaying).toHaveBeenCalledTimes(1);
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('retries muted when autoplay is refused', async () => {
    const harness = mountPlayer();
    harness.video.play.mockRejectedValueOnce(new Error('NotAllowedError'));

    await handshake(harness);

    await vi.waitFor(() => expect(harness.video.play).toHaveBeenCalledTimes(2));
    expect(harness.video.muted).toBe(true);
    expect(harness.onDead).not.toHaveBeenCalled();
  });
});

describe('handshake timeout', () => {
  it('dies when no frame is presented within the budget', async () => {
    vi.useFakeTimers();
    const harness = mountPlayer();
    await handshake(harness);

    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);

    // A connected peer connection is not evidence of a decoded frame — this is
    // exactly the silent failure WebRTC gives no event for.
    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('handshake-timeout');
  });

  it('is disarmed once playback actually starts', async () => {
    vi.useFakeTimers();
    const harness = mountPlayer();
    await handshake(harness);
    startPlayback(harness.video);

    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS * 4);

    expect(harness.onPlaying).toHaveBeenCalledTimes(1);
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('does not fire after destroy()', () => {
    vi.useFakeTimers();
    const harness = mountPlayer();
    harness.player.destroy();

    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS * 2);

    expect(harness.onDead).not.toHaveBeenCalled();
  });
});

describe('connection state', () => {
  it('treats disconnected as survivable on both state machines', async () => {
    const harness = mountPlayer();
    await handshake(harness);

    harness.pc.setConnectionState('disconnected');
    harness.pc.setIceConnectionState('disconnected');

    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('dies when connectionState fails', async () => {
    const harness = mountPlayer();
    await handshake(harness);

    harness.pc.setConnectionState('failed');

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-error');
  });

  it('dies when iceConnectionState fails', async () => {
    const harness = mountPlayer();
    await handshake(harness);

    harness.pc.setIceConnectionState('failed');

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-error');
  });

  it('dies only once when disconnected precedes failed', async () => {
    const harness = mountPlayer();
    await handshake(harness);

    harness.pc.setConnectionState('disconnected');
    harness.pc.setConnectionState('failed');
    harness.pc.setIceConnectionState('failed');

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-error');
  });
});

describe('death mapping', () => {
  it('maps a socket close to ws-close, even after media is flowing', async () => {
    const harness = mountPlayer();
    await handshake(harness);
    startPlayback(harness.video);

    harness.socket.serverClose(1006, 'abnormal');

    // Deliberate: go2rtc does not close this socket on its own, so a close
    // means go2rtc went away — remount rather than trust a live-looking PC.
    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-close');
  });

  it('maps a socket error to ws-error', async () => {
    const harness = mountPlayer();
    await handshake(harness);

    harness.socket.serverError();

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-error');
  });

  it('maps a go2rtc protocol error message to ws-error', async () => {
    const harness = mountPlayer();
    harness.socket.serverOpen();
    await flush();

    harness.socket.serverJson({ type: 'error', value: 'stream not found' });

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-error');
  });

  it('maps an answer with no SDP to ws-error', async () => {
    const harness = mountPlayer();
    harness.socket.serverOpen();
    await flush();

    harness.socket.serverJson({ type: 'webrtc/answer', value: '' });
    await flush();

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-error');
  });

  it('maps an answer the peer connection rejects to ws-error', async () => {
    const harness = mountPlayer();
    harness.socket.serverOpen();
    await flush();
    harness.pc.setRemoteDescriptionError = new Error('InvalidAccessError');

    harness.socket.serverJson({ type: 'webrtc/answer', value: 'not really sdp' });
    await flush();

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-error');
  });

  it('maps a failure to produce an offer to ws-error', async () => {
    // `createOffer` is called during `mount()`, so the failure has to be armed
    // by the constructor.
    class FailsToOffer extends FakePeerConnection {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        this.createOfferError = new Error('NotSupportedError');
      }
    }
    const player = new WebRtcPlayer({
      webSocketImpl,
      peerConnectionImpl: FailsToOffer as unknown as PeerConnectionConstructor,
    });
    const onDead = vi.fn<(reason: DeathReason) => void>();
    player.onDead = onDead;
    player.mount(new FakeVideo() as unknown as HTMLVideoElement, WS_URL);

    await flush();

    expect(onDead).toHaveBeenCalledExactlyOnceWith('ws-error');
  });

  it('maps a <video> error to media-error', async () => {
    const harness = mountPlayer();
    await handshake(harness);
    harness.video.error = { code: 3, message: 'decode' } as MediaError;

    harness.video.emit('error');

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('media-error');
  });

  it('dies exactly once however many failures pile up', async () => {
    const harness = mountPlayer();
    await handshake(harness);

    harness.socket.serverClose(1006, 'abnormal');
    harness.socket.serverError();
    harness.pc.setConnectionState('failed');
    harness.video.emit('error');

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-close');
  });

  it('survives the supervisor destroying it from inside onDead', async () => {
    const harness = mountPlayer();
    await handshake(harness);
    const pc = harness.pc;
    // What the supervisor actually does: discard the dead player immediately.
    harness.onDead.mockImplementation(() => harness.player.destroy());

    expect(() => pc.setConnectionState('failed')).not.toThrow();

    harness.video.emit('error');
    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-error');
  });

  it('closes the socket and the peer connection when it dies', async () => {
    const harness = mountPlayer();
    await handshake(harness);
    const socket = harness.socket;
    const pc = harness.pc;

    harness.video.emit('error');

    expect(socket.closeCalls).toBe(1);
    expect(pc.closeCalls).toBe(1);
  });
});

describe('destroy', () => {
  it('releases the socket, the peer connection and the element', async () => {
    const harness = mountPlayer();
    await handshake(harness);
    const socket = harness.socket;
    const pc = harness.pc;

    harness.player.destroy();

    expect(socket.closeCalls).toBe(1);
    expect(pc.closeCalls).toBe(1);
    expect(pc.transceivers.map((t) => t.stopCalls)).toEqual([1, 1]);
    expect(harness.video.srcObject).toBeNull();
    expect(harness.video.load).toHaveBeenCalledTimes(1);
  });

  it('is idempotent and safe before mount()', () => {
    const player = new WebRtcPlayer({ webSocketImpl, peerConnectionImpl });
    const onDead = vi.fn<(reason: DeathReason) => void>();
    player.onDead = onDead;

    expect(() => {
      player.destroy();
      player.destroy();
    }).not.toThrow();
    expect(onDead).not.toHaveBeenCalled();
  });

  it('never fires a callback afterwards', async () => {
    const harness = mountPlayer();
    await handshake(harness);
    const socket = harness.socket;
    const pc = harness.pc;

    harness.player.destroy();
    harness.player.destroy();

    socket.serverClose(1006, 'abnormal');
    socket.serverError();
    pc.setConnectionState('failed');
    pc.setIceConnectionState('failed');
    pc.emitTrack(fakeTrack('video'), [remoteStream()]);
    harness.video.emit('error');
    startPlayback(harness.video);
    await flush();

    expect(harness.onDead).not.toHaveBeenCalled();
    expect(harness.onPlaying).not.toHaveBeenCalled();
  });

  it('ignores a mount() after destroy()', () => {
    const player = new WebRtcPlayer({ webSocketImpl, peerConnectionImpl });
    player.destroy();

    player.mount(new FakeVideo() as unknown as HTMLVideoElement, WS_URL);

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(FakePeerConnection.instances).toHaveLength(0);
  });
});
