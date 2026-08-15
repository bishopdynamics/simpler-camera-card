import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Go2rtcClient,
  type Go2rtcMessage,
  type WebSocketConstructor,
} from '../../src/player/go2rtc-client';
import { FakeWebSocket } from './stubs';

const WS_URL = 'wss://ha.local/api/frigate/frigate/go2rtc/ws/api/ws?src=front_yard&authSig=sig';

const webSocketImpl = FakeWebSocket as unknown as WebSocketConstructor;

/** A connected client plus its socket, with every lifecycle callback spied. */
function connectedClient(url = WS_URL) {
  const client = new Go2rtcClient(url, { webSocketImpl });
  const callbacks = {
    onOpen: vi.fn(),
    onBinary: vi.fn<(data: ArrayBuffer) => void>(),
    onClose: vi.fn<(code: number, reason: string) => void>(),
    onError: vi.fn(),
  };
  Object.assign(client, callbacks);
  client.connect();
  return { client, socket: FakeWebSocket.last(), ...callbacks };
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('connect', () => {
  it('opens one socket on the URL it was handed and asks for binary frames', () => {
    const { client, socket } = connectedClient();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.url).toBe(WS_URL);
    expect(socket.binaryType).toBe('arraybuffer');
    expect(client.isOpen).toBe(false);

    socket.serverOpen();
    expect(client.isOpen).toBe(true);
  });

  it('is idempotent', () => {
    const { client } = connectedClient();
    client.connect();
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does nothing after close()', () => {
    const client = new Go2rtcClient(WS_URL, { webSocketImpl });
    client.close();
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('reports a socket that cannot be constructed as an error', () => {
    const onError = vi.fn();
    const exploding = class {
      constructor() {
        throw new Error('SyntaxError: bad url');
      }
    } as unknown as WebSocketConstructor;

    const client = new Go2rtcClient('not a url', { webSocketImpl: exploding });
    client.onError = onError;
    client.connect();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(client.isFinished).toBe(true);
  });
});

describe('outbound messages', () => {
  it('queues messages sent before open and flushes them in order', () => {
    const { client, socket, onOpen } = connectedClient();

    client.send({ type: 'mse', value: 'avc1.640029' });
    client.send({ type: 'webrtc/candidate', value: 'candidate:1' });
    expect(socket.sent).toEqual([]);

    socket.serverOpen();

    expect(socket.sentMessages).toEqual([
      { type: 'mse', value: 'avc1.640029' },
      { type: 'webrtc/candidate', value: 'candidate:1' },
    ]);
    // The queue is flushed before the owner is told the socket is open.
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('sends straight through once open', () => {
    const { client, socket } = connectedClient();
    socket.serverOpen();
    client.send({ type: 'mse', value: 'avc1.640029' });
    expect(socket.sentMessages).toEqual([{ type: 'mse', value: 'avc1.640029' }]);
  });

  it('swallows a send that races a close, leaving the close to report it', () => {
    const { client, socket } = connectedClient();
    socket.serverOpen();
    socket.readyState = 3; // FakeWebSocket.send throws in this state

    expect(() => client.send({ type: 'mse' })).not.toThrow();
    expect(socket.sent).toEqual([]);
  });

  it('is a no-op after close()', () => {
    const { client, socket } = connectedClient();
    socket.serverOpen();
    client.close();
    client.send({ type: 'mse' });
    expect(socket.sent).toEqual([]);
  });
});

describe('JSON lane', () => {
  it('dispatches messages to the subscribers of their type', () => {
    const { client, socket } = connectedClient();
    const onMse = vi.fn<(message: Go2rtcMessage) => void>();
    const onAnswer = vi.fn<(message: Go2rtcMessage) => void>();
    client.on('mse', onMse);
    client.on('webrtc/answer', onAnswer);
    socket.serverOpen();

    socket.serverJson({ type: 'mse', value: 'video/mp4; codecs="avc1.640029"' });

    expect(onMse).toHaveBeenCalledTimes(1);
    expect(onMse).toHaveBeenCalledWith({ type: 'mse', value: 'video/mp4; codecs="avc1.640029"' });
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('supports several subscribers per type, and unsubscribing', () => {
    const { client, socket } = connectedClient();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = client.on('mse', first);
    client.on('mse', second);
    socket.serverOpen();

    socket.serverJson({ type: 'mse', value: 'a' });
    unsubscribe();
    socket.serverJson({ type: 'mse', value: 'b' });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('ignores frames that are not usable go2rtc messages', () => {
    const { client, socket } = connectedClient();
    const onMse = vi.fn();
    client.on('mse', onMse);
    socket.serverOpen();

    socket.serverText('this is not json');
    socket.serverJson(['not', 'an', 'object']);
    socket.serverJson({ value: 'no type' });

    expect(onMse).not.toHaveBeenCalled();
  });

  it('does not dispatch after the client is closed', () => {
    const { client, socket } = connectedClient();
    const onMse = vi.fn();
    client.on('mse', onMse);
    socket.serverOpen();
    client.close();

    socket.serverJson({ type: 'mse', value: 'a' });
    expect(onMse).not.toHaveBeenCalled();
  });
});

describe('binary lane', () => {
  it('routes ArrayBuffer frames to onBinary', () => {
    const { socket, onBinary } = connectedClient();
    socket.serverOpen();
    const data = new Uint8Array([1, 2, 3]).buffer;

    socket.serverBinary(data);

    expect(onBinary).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(onBinary.mock.calls[0][0])).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('copies typed-array views out to their own buffer', () => {
    const { socket, onBinary } = connectedClient();
    socket.serverOpen();
    const view = new Uint8Array([9, 8, 7, 6]).subarray(1, 3);

    socket.serverBinary(view);

    expect(new Uint8Array(onBinary.mock.calls[0][0])).toEqual(new Uint8Array([8, 7]));
  });

  it('drops frames it cannot deliver in order (Blob)', () => {
    const { socket, onBinary } = connectedClient();
    socket.serverOpen();

    socket.serverBinary({ size: 3 } as unknown as ArrayBuffer);

    expect(onBinary).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('reports a remote close once, with its code and reason', () => {
    const { client, socket, onClose } = connectedClient();
    socket.serverOpen();

    socket.serverClose(1006, 'abnormal');
    socket.serverClose(1006, 'abnormal');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(1006, 'abnormal');
    expect(client.isFinished).toBe(true);
    expect(client.isOpen).toBe(false);
  });

  it('reports a socket error once and releases the socket', () => {
    const { client, socket, onError, onClose } = connectedClient();
    socket.serverOpen();

    socket.serverError();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(client.isFinished).toBe(true);
    // The socket is not left open with live handlers behind an error.
    expect(socket.closeCalls).toBe(1);
    socket.serverClose();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('close() shuts the socket without reporting a death', () => {
    const { client, socket, onClose, onError } = connectedClient();
    socket.serverOpen();

    client.close();
    client.close();

    expect(socket.closeCalls).toBe(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(client.isFinished).toBe(true);
  });

  it('ignores a socket open that arrives after close()', () => {
    const { client, socket, onOpen } = connectedClient();
    client.close();

    socket.serverOpen();

    expect(onOpen).not.toHaveBeenCalled();
    expect(client.isOpen).toBe(false);
  });
});
