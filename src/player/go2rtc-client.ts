/**
 * `player/go2rtc-client.ts` — a typed client for go2rtc's WebSocket API.
 *
 * go2rtc's `/api/ws` endpoint speaks a tiny protocol (documented upstream in
 * `internal/api/ws/README.md`): the client sends JSON messages of the shape
 * `{ type, value }`, the server replies with JSON messages of the same shape,
 * and — once a media lane has been negotiated — pushes the media itself as
 * **binary** frames on the same socket. For MSE those binary frames are fMP4
 * boxes (`ftyp`+`moov`, then a stream of `moof`+`mdat`); for WebRTC there are
 * no binary frames at all, only `webrtc/offer`, `webrtc/answer` and
 * `webrtc/candidate` JSON messages.
 *
 * This client is therefore deliberately transport-agnostic:
 *
 * - **JSON lane** — subscribe by message `type` with {@link Go2rtcClient.on}.
 *   The MSE player subscribes to `mse`; slice 7's WebRTC player subscribes to
 *   `webrtc/answer` and `webrtc/candidate` over the *same* client, with no
 *   change needed here.
 * - **Binary lane** — a single {@link Go2rtcClient.onBinary} handler, because
 *   only one media lane is ever active per socket.
 *
 * Scope, deliberately:
 *
 * - It is handed an already-signed absolute URL and never builds, signs or
 *   re-signs one (`endpoint.ts` owns that, per attempt).
 * - It contains **no reconnect logic**. Like the player that owns it, a client
 *   is one-shot: it opens once, and once it is closed or dead it stays that
 *   way. Recovery is the supervisor's job (`reliability/supervisor.ts`).
 * - Outbound messages sent before the socket opens are queued in order and
 *   flushed on open. The queue is fed only by this client's owner (a handful
 *   of handshake messages), never by the network, so — unlike the inbound
 *   media staging queue in `mse-player.ts` — it needs no bounds check.
 */

const LOG_PREFIX = '[simpler-camera-card]';

/** A go2rtc protocol message. `value` is `type`-dependent and left untyped. */
export interface Go2rtcMessage {
  type: string;
  value?: unknown;
}

/** Receives every JSON message of one `type`. */
export type Go2rtcMessageHandler = (message: Go2rtcMessage) => void;

/** Cancels a {@link Go2rtcClient.on} subscription. */
export type Unsubscribe = () => void;

/**
 * The `WebSocket` implementation to use. Injectable so tests can drive the
 * protocol without a network; defaults to the global `WebSocket`.
 */
export type WebSocketConstructor = new (url: string) => WebSocket;

export interface Go2rtcClientOptions {
  /** Defaults to `globalThis.WebSocket`. */
  webSocketImpl?: WebSocketConstructor;
}

/**
 * One WebSocket to one go2rtc stream.
 *
 * Lifecycle: construct → wire callbacks → {@link connect} → … → {@link close}.
 * After `close()` (or after the socket closes or errors on its own) the client
 * is inert: no handler, subscription or lifecycle callback fires again, and
 * `send()` is a no-op. This is what lets `MsePlayer.destroy()` be both
 * idempotent and callback-free.
 */
export class Go2rtcClient {
  /** The signed URL this client was handed. */
  readonly url: string;

  private readonly webSocketImpl: WebSocketConstructor;
  private readonly subscriptions = new Map<string, Set<Go2rtcMessageHandler>>();
  /** Serialized messages sent before the socket opened, in send order. */
  private readonly outbound: string[] = [];

  private socket: WebSocket | null = null;
  private opened = false;
  private finished = false;

  /** The socket is open; the handshake may proceed. */
  onOpen: () => void = () => {};

  /**
   * A binary frame arrived. The buffer is owned by the callee (it is never
   * retained or reused here), so it is safe to stage or `appendBuffer` it.
   */
  onBinary: (data: ArrayBuffer) => void = () => {};

  /** The socket closed (remotely, or because the network dropped it). */
  onClose: (code: number, reason: string) => void = () => {};

  /** The socket errored. A `close` normally follows, but is not delivered. */
  onError: () => void = () => {};

  constructor(url: string, options: Go2rtcClientOptions = {}) {
    this.url = url;
    this.webSocketImpl =
      options.webSocketImpl ??
      (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket ??
      (undefined as unknown as WebSocketConstructor);
  }

  /** Whether the socket is currently open (and the client not yet finished). */
  get isOpen(): boolean {
    return this.opened && !this.finished;
  }

  /** Whether the client has been closed, or its socket has closed / errored. */
  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * Open the socket. Safe to call once; later calls are ignored.
   *
   * A constructor failure (malformed URL, no `WebSocket` in the environment) is
   * reported **synchronously** through {@link onError} — the owner is expected
   * to have its callbacks wired before calling this.
   */
  connect(): void {
    if (this.finished || this.socket) return;

    let socket: WebSocket;
    try {
      socket = new this.webSocketImpl(this.url);
    } catch (error) {
      console.info(`${LOG_PREFIX} go2rtc websocket could not be created:`, error);
      this.finished = true;
      this.onError();
      return;
    }

    socket.binaryType = 'arraybuffer';
    socket.onopen = () => this.handleOpen();
    socket.onmessage = (event: MessageEvent) => this.handleMessage(event);
    socket.onclose = (event: CloseEvent) => this.handleClose(event);
    socket.onerror = () => this.handleError();
    this.socket = socket;
  }

  /**
   * Send a JSON message, queueing it in order if the socket is not open yet.
   * A no-op once the client is finished.
   */
  send(message: Go2rtcMessage): void {
    if (this.finished) return;
    const text = JSON.stringify(message);
    if (this.isOpen && this.socket) {
      this.write(text);
    } else {
      this.outbound.push(text);
    }
  }

  /**
   * Subscribe to every JSON message of one `type` (e.g. `mse`,
   * `webrtc/answer`). Returns an unsubscribe function.
   */
  on(type: string, handler: Go2rtcMessageHandler): Unsubscribe {
    if (this.finished) return () => {};
    let handlers = this.subscriptions.get(type);
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(type, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  /**
   * Close the socket and go inert. Idempotent, safe before {@link connect},
   * and — by design — **does not** invoke {@link onClose}: an owner-initiated
   * close is not a death.
   */
  close(): void {
    this.finished = true;
    this.opened = false;
    this.subscriptions.clear();
    this.outbound.length = 0;
    this.releaseSocket();
  }

  /**
   * Detach every handler from the socket and close it. Called by {@link close}
   * and after a remote close/error, so a socket is never left open with live
   * handlers — even when the client went finished without its owner asking.
   */
  private releaseSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;

    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch (error) {
      // Closing an already-closing socket throws in some implementations;
      // there is nothing left to do about it here.
      console.info(`${LOG_PREFIX} go2rtc websocket close() threw:`, error);
    }
  }

  private handleOpen(): void {
    if (this.finished) return;
    this.opened = true;
    const queued = this.outbound.splice(0, this.outbound.length);
    for (const text of queued) {
      this.write(text);
    }
    this.onOpen();
  }

  private write(text: string): void {
    try {
      this.socket?.send(text);
    } catch (error) {
      // A send racing a close throws `InvalidStateError`; the close event that
      // follows is what the owner acts on.
      console.info(`${LOG_PREFIX} go2rtc websocket send() failed:`, error);
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (this.finished) return;
    const data: unknown = event.data;

    if (typeof data === 'string') {
      this.dispatchJson(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.onBinary(data);
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      this.onBinary(
        view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
      );
      return;
    }
    // `binaryType` is forced to `arraybuffer` above, so a `Blob` should be
    // unreachable; reading one would be async and would reorder the media
    // stream, so it is dropped loudly rather than handled.
    console.info(`${LOG_PREFIX} ignoring go2rtc frame of unsupported type`);
  }

  private dispatchJson(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.info(`${LOG_PREFIX} ignoring non-JSON go2rtc text frame`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      console.info(`${LOG_PREFIX} ignoring go2rtc message that is not an object`);
      return;
    }
    const message = parsed as Go2rtcMessage;
    if (typeof message.type !== 'string') {
      console.info(`${LOG_PREFIX} ignoring go2rtc message with no "type"`);
      return;
    }

    const handlers = this.subscriptions.get(message.type);
    if (!handlers || handlers.size === 0) {
      console.info(`${LOG_PREFIX} unhandled go2rtc message type "${message.type}"`);
      return;
    }
    // Copy: a handler may unsubscribe (or close the client) while dispatching.
    for (const handler of [...handlers]) {
      if (this.finished) return;
      handler(message);
    }
  }

  private handleClose(event: CloseEvent): void {
    if (this.finished) return;
    const code = event?.code ?? 0;
    const reason = event?.reason ?? '';
    this.finished = true;
    this.opened = false;
    this.socket = null;
    this.subscriptions.clear();
    this.outbound.length = 0;
    this.onClose(code, reason);
  }

  private handleError(): void {
    if (this.finished) return;
    this.finished = true;
    this.opened = false;
    this.subscriptions.clear();
    this.outbound.length = 0;
    // An `error` is not always followed by a usable `close`, and the socket is
    // of no further use either way.
    this.releaseSocket();
    this.onError();
  }
}
