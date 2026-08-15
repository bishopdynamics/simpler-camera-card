/**
 * Test doubles for the browser APIs the player slice drives.
 *
 * happy-dom implements neither `WebSocket` server behaviour nor Media Source
 * Extensions, and both are injectable into `MsePlayer` / `Go2rtcClient`
 * precisely so these stubs can stand in. Each double exposes plain
 * `server*` / `emit*` methods so a test drives the protocol explicitly rather
 * than waiting on timing.
 *
 * Everything here is cast to its DOM type at the injection site: the doubles
 * implement the members the production code actually touches, not the full
 * (and largely irrelevant) interfaces.
 */

import { vi } from 'vitest';

/* -------------------------------------------------------------------------- */
/* WebSocket                                                                   */
/* -------------------------------------------------------------------------- */

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  /** The most recently constructed socket. */
  static last(): FakeWebSocket {
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!socket) throw new Error('no FakeWebSocket has been constructed');
    return socket;
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  readonly url: string;
  binaryType = 'blob';
  readyState = 0;
  /** Raw text frames handed to `send()`. */
  readonly sent: string[] = [];
  closeCalls = 0;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error('InvalidStateError: socket is not open');
    }
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  /** Parsed view of everything the client has sent. */
  get sentMessages(): { type: string; value?: unknown }[] {
    return this.sent.map((text) => JSON.parse(text) as { type: string; value?: unknown });
  }

  /* --- server side ------------------------------------------------------ */

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  serverJson(message: unknown): void {
    this.serverText(JSON.stringify(message));
  }

  serverText(text: string): void {
    this.onmessage?.({ data: text } as MessageEvent);
  }

  serverBinary(data: ArrayBuffer | ArrayBufferView): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  serverError(): void {
    this.onerror?.(new Event('error'));
  }
}

/* -------------------------------------------------------------------------- */
/* Media Source Extensions                                                     */
/* -------------------------------------------------------------------------- */

/** A `TimeRanges` over an explicit list of `[start, end]` pairs. */
export function fakeTimeRanges(ranges: readonly [number, number][]): TimeRanges {
  return {
    length: ranges.length,
    start: (index: number) => ranges[index][0],
    end: (index: number) => ranges[index][1],
  } as unknown as TimeRanges;
}

export class FakeSourceBuffer extends EventTarget {
  mode = 'sequence';
  updating = false;
  /** Every buffer handed to `appendBuffer`, in order. */
  readonly appended: Uint8Array[] = [];
  /** Every `[start, end]` handed to `remove`. */
  readonly removed: [number, number][] = [];
  abortCalls = 0;
  /** When set, `appendBuffer` throws it (models `QuotaExceededError`). */
  appendError: Error | null = null;
  /** Backs the `buffered` accessor. */
  ranges: [number, number][] = [];

  get buffered(): TimeRanges {
    return fakeTimeRanges(this.ranges);
  }

  appendBuffer(data: BufferSource): void {
    if (this.appendError) throw this.appendError;
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
      : new Uint8Array(data as ArrayBuffer);
    this.appended.push(view);
    this.updating = true;
  }

  remove(start: number, end: number): void {
    if (this.updating) throw new Error('InvalidStateError: buffer is updating');
    this.removed.push([start, end]);
    this.updating = true;
  }

  abort(): void {
    this.abortCalls += 1;
    this.updating = false;
  }

  /** Complete the pending update, as the browser would. */
  finishUpdate(): void {
    this.updating = false;
    this.dispatchEvent(new Event('updateend'));
  }

  emitError(): void {
    this.dispatchEvent(new Event('error'));
  }
}

export class FakeMediaSource extends EventTarget {
  static instances: FakeMediaSource[] = [];
  /** Overridable codec support predicate. */
  static supports: (type: string) => boolean = () => true;

  static isTypeSupported(type: string): boolean {
    return FakeMediaSource.supports(type);
  }

  static last(): FakeMediaSource {
    const mediaSource = FakeMediaSource.instances[FakeMediaSource.instances.length - 1];
    if (!mediaSource) throw new Error('no FakeMediaSource has been constructed');
    return mediaSource;
  }

  static reset(): void {
    FakeMediaSource.instances = [];
    FakeMediaSource.supports = () => true;
  }

  readyState: 'closed' | 'open' | 'ended' = 'closed';
  readonly sourceBuffers: FakeSourceBuffer[] = [];
  /** The mime type passed to `addSourceBuffer`. */
  mime: string | null = null;
  /** When set, `addSourceBuffer` throws it. */
  addSourceBufferError: Error | null = null;
  removeSourceBufferCalls = 0;

  constructor() {
    super();
    FakeMediaSource.instances.push(this);
  }

  addSourceBuffer(mime: string): FakeSourceBuffer {
    if (this.addSourceBufferError) throw this.addSourceBufferError;
    this.mime = mime;
    const sourceBuffer = new FakeSourceBuffer();
    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  }

  removeSourceBuffer(): void {
    this.removeSourceBufferCalls += 1;
  }

  endOfStream(): void {}

  /** Attach: what the element does once it has picked up the object URL. */
  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('sourceopen'));
  }

  /** The single source buffer, once opened. */
  get sourceBuffer(): FakeSourceBuffer {
    const sourceBuffer = this.sourceBuffers[0];
    if (!sourceBuffer) throw new Error('no SourceBuffer has been added');
    return sourceBuffer;
  }
}

/* -------------------------------------------------------------------------- */
/* WebRTC                                                                      */
/* -------------------------------------------------------------------------- */

/** A `MediaStreamTrack` with only the fields the players read. */
export function fakeTrack(kind: 'video' | 'audio', id = `${kind}-1`): MediaStreamTrack {
  return { kind, id } as unknown as MediaStreamTrack;
}

/** A `MediaStream` that records what was added to it. */
export class FakeMediaStream {
  readonly tracks: MediaStreamTrack[] = [];

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
  }
}

/** The transceiver surface `WebRtcPlayer` touches: a kind, a direction, `stop`. */
export class FakeTransceiver {
  stopCalls = 0;

  constructor(
    readonly kind: string,
    readonly direction: string | undefined,
  ) {}

  stop(): void {
    this.stopCalls += 1;
  }
}

/**
 * An `RTCPeerConnection` double.
 *
 * The promise-returning methods resolve on the microtask queue exactly as the
 * real ones do, which is what makes the "candidate arrives while the answer is
 * still being applied" window reproducible in a test. `addIceCandidate` throws
 * without a remote description, like every browser implementation, so a test
 * fails loudly if the player ever adds one too early.
 */
export class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];

  static last(): FakePeerConnection {
    const pc = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
    if (!pc) throw new Error('no FakePeerConnection has been constructed');
    return pc;
  }

  static reset(): void {
    FakePeerConnection.instances = [];
  }

  /** SDP handed back by `createOffer`. */
  static offerSdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';

  readonly configuration?: RTCConfiguration;
  readonly transceivers: FakeTransceiver[] = [];
  readonly addedCandidates: RTCIceCandidateInit[] = [];

  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  closeCalls = 0;

  /** When set, the matching method rejects with it. */
  createOfferError: Error | null = null;
  setRemoteDescriptionError: Error | null = null;
  addIceCandidateError: Error | null = null;

  constructor(configuration?: RTCConfiguration) {
    super();
    this.configuration = configuration;
    FakePeerConnection.instances.push(this);
  }

  addTransceiver(kind: string, init?: { direction?: string }): FakeTransceiver {
    const transceiver = new FakeTransceiver(kind, init?.direction);
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers(): FakeTransceiver[] {
    return [...this.transceivers];
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    if (this.createOfferError) throw this.createOfferError;
    return { type: 'offer', sdp: FakePeerConnection.offerSdp };
  }

  async setLocalDescription(description: { type: string; sdp?: string }): Promise<void> {
    this.localDescription = { type: description.type, sdp: description.sdp ?? '' };
  }

  async setRemoteDescription(description: { type: string; sdp?: string }): Promise<void> {
    if (this.setRemoteDescriptionError) throw this.setRemoteDescriptionError;
    this.remoteDescription = { type: description.type, sdp: description.sdp ?? '' };
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.addIceCandidateError) throw this.addIceCandidateError;
    if (!this.remoteDescription) {
      throw new Error('InvalidStateError: no remote description has been set');
    }
    this.addedCandidates.push(candidate);
  }

  close(): void {
    this.closeCalls += 1;
  }

  /* --- remote side ------------------------------------------------------ */

  /** Deliver a `track` event, optionally with go2rtc's own stream. */
  emitTrack(track: MediaStreamTrack, streams: MediaStream[] = []): void {
    this.dispatchEvent(Object.assign(new Event('track'), { track, streams }));
  }

  /** Trickle a local candidate out; `null` means gathering is complete. */
  emitIceCandidate(candidate: string | null): void {
    this.dispatchEvent(
      Object.assign(new Event('icecandidate'), {
        candidate: candidate === null ? null : { candidate },
      }),
    );
  }

  setConnectionState(state: string): void {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }

  setIceConnectionState(state: string): void {
    this.iceConnectionState = state;
    this.dispatchEvent(new Event('iceconnectionstatechange'));
  }
}

/* -------------------------------------------------------------------------- */
/* <video>                                                                     */
/* -------------------------------------------------------------------------- */

export class FakeVideo extends EventTarget {
  src = '';
  /** Set by the WebRTC player; left untouched by the MSE one. */
  srcObject: MediaStream | null = null;
  muted = false;
  seeking = false;
  currentTime = 0;
  playbackRate = 1;
  error: MediaError | null = null;
  readonly play = vi.fn<() => Promise<void>>(() => Promise.resolve());
  readonly load = vi.fn<() => void>();

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  /** Fire a media event (`timeupdate`, `error`, …). */
  emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }

  /** Advance playback and fire the `timeupdate` the player listens for. */
  advanceTo(time: number): void {
    this.currentTime = time;
    this.emit('timeupdate');
  }
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Install object-URL stubs (happy-dom's `createObjectURL` rejects anything that
 * is not a real `Blob`). Returns a restore function.
 */
export function installObjectUrlStubs(): () => void {
  const url = URL as unknown as {
    createObjectURL?: (object: unknown) => string;
    revokeObjectURL?: (value: string) => void;
  };
  const previousCreate = url.createObjectURL;
  const previousRevoke = url.revokeObjectURL;
  let counter = 0;
  url.createObjectURL = () => `blob:fake-${(counter += 1)}`;
  url.revokeObjectURL = () => {};
  return () => {
    url.createObjectURL = previousCreate;
    url.revokeObjectURL = previousRevoke;
  };
}

/** A few bytes standing in for an fMP4 box. */
export function segment(byteLength = 8, fill = 1): ArrayBuffer {
  return new Uint8Array(byteLength).fill(fill).buffer;
}
