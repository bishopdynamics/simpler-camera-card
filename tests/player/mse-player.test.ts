import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_EDGE_TARGET_LAG_S,
  MAX_BACK_BUFFER_S,
  MAX_STAGED_BYTES,
  MAX_STAGED_SEGMENTS,
  MsePlayer,
  supportedCodecs,
  type MediaSourceConstructor,
} from '../../src/player/mse-player';
import type { WebSocketConstructor } from '../../src/player/go2rtc-client';
import { HANDSHAKE_TIMEOUT_MS, type DeathReason } from '../../src/types';
import { FakeMediaSource, FakeVideo, FakeWebSocket, installObjectUrlStubs, segment } from './stubs';

const WS_URL = 'wss://ha.local/api/frigate/frigate/go2rtc/ws/api/ws?src=front_yard&authSig=sig';
const MIME = 'video/mp4; codecs="avc1.640029,mp4a.40.2"';

const webSocketImpl = FakeWebSocket as unknown as WebSocketConstructor;
const mediaSourceImpl = FakeMediaSource as unknown as MediaSourceConstructor;

let restoreObjectUrl: () => void;

beforeEach(() => {
  FakeWebSocket.reset();
  FakeMediaSource.reset();
  restoreObjectUrl = installObjectUrlStubs();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  restoreObjectUrl();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A mounted player with its stubs and spied callbacks. */
function mountPlayer() {
  const player = new MsePlayer({ webSocketImpl, mediaSourceImpl });
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
    get mediaSource() {
      return FakeMediaSource.last();
    },
  };
}

/** Drive the full handshake: attach, open socket, accept go2rtc's codec reply. */
function handshake(harness: ReturnType<typeof mountPlayer>) {
  harness.mediaSource.open();
  harness.socket.serverOpen();
  harness.socket.serverJson({ type: 'mse', value: MIME });
  return harness.mediaSource.sourceBuffer;
}

/** Two advancing `timeupdate`s — what the player treats as "really playing". */
function startPlayback(video: FakeVideo, from = 10) {
  video.advanceTo(from);
  video.advanceTo(from + 0.25);
}

describe('handshake', () => {
  it('attaches a MediaSource and opens the signed socket', () => {
    const harness = mountPlayer();

    expect(harness.socket.url).toBe(WS_URL);
    expect(harness.video.src).toMatch(/^blob:/);
    expect(FakeMediaSource.instances).toHaveLength(1);
  });

  it('announces only the codecs this browser supports, on sourceopen', () => {
    FakeMediaSource.supports = (type) => type.includes('avc1.640029');
    const harness = mountPlayer();

    harness.mediaSource.open();
    // Queued by the client until the socket is actually open.
    expect(harness.socket.sent).toEqual([]);
    harness.socket.serverOpen();

    expect(harness.socket.sentMessages).toEqual([{ type: 'mse', value: 'avc1.640029' }]);
  });

  it('tolerates the socket opening before the MediaSource does', () => {
    const harness = mountPlayer();

    harness.socket.serverOpen();
    harness.mediaSource.open();

    expect(harness.socket.sentMessages).toHaveLength(1);
    expect(harness.socket.sentMessages[0].type).toBe('mse');
  });

  it("opens a SourceBuffer on go2rtc's mime type and starts playback", () => {
    const harness = mountPlayer();

    const sourceBuffer = handshake(harness);

    expect(harness.mediaSource.mime).toBe(MIME);
    expect(sourceBuffer.mode).toBe('segments');
    expect(harness.video.play).toHaveBeenCalledTimes(1);
  });

  it('appends binary frames as they arrive', () => {
    const harness = mountPlayer();
    const sourceBuffer = handshake(harness);

    harness.socket.serverBinary(segment(4, 7));

    expect(sourceBuffer.appended).toHaveLength(1);
    expect(sourceBuffer.appended[0]).toEqual(new Uint8Array([7, 7, 7, 7]));
  });

  it('reports playing on the first advancing timeupdate, once', () => {
    const harness = mountPlayer();
    handshake(harness);

    harness.video.advanceTo(10);
    expect(harness.onPlaying).not.toHaveBeenCalled(); // no advance to compare against yet

    harness.video.advanceTo(10.25);
    harness.video.advanceTo(10.5);

    expect(harness.onPlaying).toHaveBeenCalledTimes(1);
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('dies when the browser supports none of the offered codecs', () => {
    FakeMediaSource.supports = () => false;
    const player = new MsePlayer({ webSocketImpl, mediaSourceImpl });
    const onDead = vi.fn<(reason: DeathReason) => void>();
    player.onDead = onDead;

    player.mount(new FakeVideo() as unknown as HTMLVideoElement, WS_URL);

    expect(onDead).toHaveBeenCalledExactlyOnceWith('media-error');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('dies when go2rtc offers no codec for the stream', () => {
    const harness = mountPlayer();
    harness.mediaSource.open();
    harness.socket.serverOpen();

    harness.socket.serverJson({ type: 'mse', value: '' });

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('media-error');
  });

  it('ignores a second mount()', () => {
    const harness = mountPlayer();
    harness.player.mount(new FakeVideo() as unknown as HTMLVideoElement, WS_URL);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('handshake timeout', () => {
  it('dies when no frame is presented within the budget', () => {
    vi.useFakeTimers();
    const harness = mountPlayer();
    handshake(harness);
    harness.socket.serverBinary(segment());

    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);

    // Appending media is not enough: `types.ts` budgets time to the first frame.
    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('handshake-timeout');
  });

  it('is disarmed once playback actually starts', () => {
    vi.useFakeTimers();
    const harness = mountPlayer();
    handshake(harness);
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

describe('death mapping', () => {
  it('maps a socket close to ws-close', () => {
    const harness = mountPlayer();
    handshake(harness);

    harness.socket.serverClose(1006, 'abnormal');

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-close');
  });

  it('maps a socket error to ws-error', () => {
    const harness = mountPlayer();
    handshake(harness);

    harness.socket.serverError();

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-error');
  });

  it('maps a go2rtc protocol error message to ws-error', () => {
    const harness = mountPlayer();
    harness.mediaSource.open();
    harness.socket.serverOpen();

    harness.socket.serverJson({ type: 'error', value: 'stream not found' });

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-error');
  });

  it('maps a <video> error to media-error', () => {
    const harness = mountPlayer();
    handshake(harness);
    harness.video.error = { code: 3, message: 'decode' } as MediaError;

    harness.video.emit('error');

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('media-error');
  });

  it('maps a SourceBuffer error to media-error', () => {
    const harness = mountPlayer();
    const sourceBuffer = handshake(harness);

    sourceBuffer.emitError();

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('media-error');
  });

  it('dies exactly once however many failures pile up', () => {
    const harness = mountPlayer();
    const sourceBuffer = handshake(harness);

    harness.socket.serverClose(1006, 'abnormal');
    harness.socket.serverError();
    harness.video.emit('error');
    sourceBuffer.emitError();

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-close');
  });

  it('survives the supervisor destroying it from inside onDead', () => {
    const harness = mountPlayer();
    const sourceBuffer = handshake(harness);
    // What the supervisor actually does: discard the dead player immediately.
    harness.onDead.mockImplementation(() => harness.player.destroy());

    expect(() => harness.socket.serverClose(1006, 'abnormal')).not.toThrow();

    sourceBuffer.emitError();
    harness.video.emit('error');
    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('ws-close');
  });

  it('closes the socket when it dies, so nothing arrives afterwards', () => {
    const harness = mountPlayer();
    const socket = harness.socket;
    handshake(harness);

    harness.video.error = { code: 3, message: 'decode' } as MediaError;
    harness.video.emit('error');

    expect(socket.closeCalls).toBe(1);
  });
});

describe('staging queue', () => {
  /** Put the SourceBuffer into `updating`, so further frames must be staged. */
  function busySourceBuffer(harness: ReturnType<typeof mountPlayer>) {
    const sourceBuffer = handshake(harness);
    harness.socket.serverBinary(segment());
    expect(sourceBuffer.updating).toBe(true);
    return sourceBuffer;
  }

  it('stages frames that arrive while the SourceBuffer is updating', () => {
    const harness = mountPlayer();
    const sourceBuffer = busySourceBuffer(harness);

    harness.socket.serverBinary(segment(2, 5));
    harness.socket.serverBinary(segment(2, 6));
    expect(sourceBuffer.appended).toHaveLength(1);

    sourceBuffer.finishUpdate();

    // Both staged frames are appended together, in arrival order.
    expect(sourceBuffer.appended).toHaveLength(2);
    expect(sourceBuffer.appended[1]).toEqual(new Uint8Array([5, 5, 6, 6]));
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('dies rather than growing without bound (segment cap)', () => {
    const harness = mountPlayer();
    busySourceBuffer(harness);

    for (let i = 0; i <= MAX_STAGED_SEGMENTS + 5; i += 1) {
      harness.socket.serverBinary(segment(4));
    }

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('media-error');
  });

  it('dies rather than growing without bound (byte cap)', () => {
    const harness = mountPlayer();
    busySourceBuffer(harness);
    const oneMegabyte = 1024 * 1024;

    for (let staged = 0; staged <= MAX_STAGED_BYTES; staged += oneMegabyte) {
      harness.socket.serverBinary(segment(oneMegabyte));
    }

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('media-error');
  });

  it('surfaces an appendBuffer exception instead of swallowing it', () => {
    const harness = mountPlayer();
    const sourceBuffer = handshake(harness);
    sourceBuffer.appendError = new Error('QuotaExceededError');

    harness.socket.serverBinary(segment());

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('media-error');
  });
});

describe('buffer hygiene', () => {
  /** Handshake, start playback, and hand back the source buffer. */
  function playing(harness: ReturnType<typeof mountPlayer>) {
    const sourceBuffer = handshake(harness);
    harness.socket.serverBinary(segment());
    startPlayback(harness.video);
    return sourceBuffer;
  }

  it('trims the back-buffer to the last few seconds', () => {
    const harness = mountPlayer();
    const sourceBuffer = playing(harness);
    sourceBuffer.ranges = [[0, 52]];
    harness.video.currentTime = 50;

    sourceBuffer.finishUpdate();

    expect(sourceBuffer.removed).toEqual([[0, 50 - MAX_BACK_BUFFER_S]]);
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('leaves a short buffer alone', () => {
    const harness = mountPlayer();
    const sourceBuffer = playing(harness);
    sourceBuffer.ranges = [[48, 52]];
    harness.video.currentTime = 50;

    sourceBuffer.finishUpdate();

    expect(sourceBuffer.removed).toEqual([]);
  });

  it('seeks to the live edge when playback falls behind', () => {
    const harness = mountPlayer();
    const sourceBuffer = playing(harness);
    sourceBuffer.ranges = [[90, 100]];
    harness.video.currentTime = 95;

    sourceBuffer.finishUpdate();

    expect(harness.video.currentTime).toBe(100 - LIVE_EDGE_TARGET_LAG_S);
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('never chases the live edge with playbackRate', () => {
    const harness = mountPlayer();
    const sourceBuffer = playing(harness);
    sourceBuffer.ranges = [[90, 100]];
    harness.video.currentTime = 95;

    sourceBuffer.finishUpdate();

    expect(harness.video.playbackRate).toBe(1);
  });

  it('declares the stream broken when it buffers far ahead of playback', () => {
    const harness = mountPlayer();
    const sourceBuffer = playing(harness);
    sourceBuffer.ranges = [[0, 100]];
    harness.video.currentTime = 80;

    sourceBuffer.finishUpdate();

    expect(harness.onDead).toHaveBeenCalledExactlyOnceWith('media-error');
  });

  it('does not judge buffer distances before playback has started', () => {
    const harness = mountPlayer();
    const sourceBuffer = handshake(harness);
    harness.socket.serverBinary(segment());
    // go2rtc timestamps are arbitrary, so this gap is meaningless until the
    // element has actually started presenting frames.
    sourceBuffer.ranges = [[1000, 1100]];
    harness.video.currentTime = 0;

    sourceBuffer.finishUpdate();

    expect(harness.onDead).not.toHaveBeenCalled();
    expect(harness.video.currentTime).toBe(0);
  });
});

describe('play()', () => {
  it('retries muted when autoplay is refused', async () => {
    const harness = mountPlayer();
    harness.video.play.mockRejectedValueOnce(new Error('NotAllowedError'));

    handshake(harness);

    await vi.waitFor(() => expect(harness.video.play).toHaveBeenCalledTimes(2));
    expect(harness.video.muted).toBe(true);
    expect(harness.onDead).not.toHaveBeenCalled();
  });

  it('does not retry after the player is gone', async () => {
    const harness = mountPlayer();
    harness.video.play.mockRejectedValueOnce(new Error('NotAllowedError'));

    handshake(harness);
    harness.player.destroy();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.video.play).toHaveBeenCalledTimes(1);
  });
});

describe('destroy', () => {
  it('releases the socket and the media pipeline', () => {
    const harness = mountPlayer();
    const socket = harness.socket;
    const sourceBuffer = handshake(harness);

    harness.player.destroy();

    expect(socket.closeCalls).toBe(1);
    expect(sourceBuffer.abortCalls).toBe(1);
    expect(harness.mediaSource.removeSourceBufferCalls).toBe(1);
    expect(harness.video.src).toBe('');
    expect(harness.video.load).toHaveBeenCalledTimes(1);
  });

  it('is idempotent and safe before mount()', () => {
    const player = new MsePlayer({ webSocketImpl, mediaSourceImpl });
    const onDead = vi.fn<(reason: DeathReason) => void>();
    player.onDead = onDead;

    expect(() => {
      player.destroy();
      player.destroy();
    }).not.toThrow();
    expect(onDead).not.toHaveBeenCalled();
  });

  it('never fires a callback afterwards', () => {
    const harness = mountPlayer();
    const socket = harness.socket;
    const sourceBuffer = handshake(harness);

    harness.player.destroy();
    harness.player.destroy();

    socket.serverClose(1006, 'abnormal');
    socket.serverError();
    socket.serverBinary(segment());
    sourceBuffer.emitError();
    harness.video.emit('error');
    startPlayback(harness.video);

    expect(harness.onDead).not.toHaveBeenCalled();
    expect(harness.onPlaying).not.toHaveBeenCalled();
  });

  it('ignores a mount() after destroy()', () => {
    const player = new MsePlayer({ webSocketImpl, mediaSourceImpl });
    player.destroy();

    player.mount(new FakeVideo() as unknown as HTMLVideoElement, WS_URL);

    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe('supportedCodecs', () => {
  it('offers the supported candidates as one comma-separated list', () => {
    FakeMediaSource.supports = (type) => type.includes('avc1.') || type.includes('mp4a.40.2');
    expect(supportedCodecs(mediaSourceImpl)).toBe('avc1.640029,avc1.64002A,avc1.640033,mp4a.40.2');
  });

  it('treats a throwing isTypeSupported as unsupported', () => {
    FakeMediaSource.supports = () => {
      throw new Error('nope');
    };
    expect(supportedCodecs(mediaSourceImpl)).toBe('');
  });
});
