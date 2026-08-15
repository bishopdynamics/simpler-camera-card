/**
 * `tests/integration/rig.ts` — the Node side of the go2rtc integration test.
 *
 * The integration suite is the only place the card's real modules meet a real
 * server: a local `go2rtc` binary transcoding an ffmpeg lavfi test pattern to
 * H.264, driven from a real Chromium through the real WebSocket protocol and
 * the real MSE lane. This module owns everything that cannot live in the
 * browser: locating tools, running (and abusing) the go2rtc process, serving
 * the harness page, and launching the browser.
 *
 * Nothing here is imported by `src/`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The go2rtc stream name the harness plays. */
export const STREAM_NAME = 'test';

/* -------------------------------------------------------------------------- */
/* Tool discovery                                                              */
/* -------------------------------------------------------------------------- */

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable named `name` on `PATH`, or `null`. */
export function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** `tools/go2rtc` (see `scripts/fetch-go2rtc.sh`) first, then `PATH`. */
export function findGo2rtc(): string | null {
  const vendored = join(REPO_ROOT, 'tools', 'go2rtc');
  if (isExecutable(vendored)) return vendored;
  return findOnPath('go2rtc');
}

/**
 * A Chromium-family browser with H.264 support.
 *
 * Deliberately *not* a Playwright-managed download: Playwright's own Chromium
 * build ships without the proprietary codecs, and H.264 is exactly what this
 * suite tests. The system Google Chrome is preferred; a distro Chromium is
 * accepted but may still lack H.264, which the harness detects and reports.
 */
export function findChrome(): string | null {
  const candidates = [
    process.env.SCC_CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter((path): path is string => typeof path === 'string' && path !== '');

  for (const candidate of candidates) {
    if (existsSync(candidate) && isExecutable(candidate)) return candidate;
  }
  return findOnPath('google-chrome') ?? findOnPath('chromium');
}

export interface Tooling {
  ok: boolean;
  reason?: string;
  ffmpeg: string | null;
  go2rtc: string | null;
  chrome: string | null;
}

/**
 * What is available locally. Missing tooling **skips** the suite rather than
 * failing it: developers should not need a media stack to run `make check`.
 */
export function probeTooling(): Tooling {
  const ffmpeg = findOnPath('ffmpeg');
  const go2rtc = findGo2rtc();
  const chrome = findChrome();

  const missing: string[] = [];
  if (!ffmpeg) missing.push('ffmpeg (install it from your package manager)');
  if (!go2rtc) missing.push('go2rtc (run scripts/fetch-go2rtc.sh)');
  if (!chrome) missing.push('Google Chrome / Chromium (set SCC_CHROME_PATH to override)');

  return {
    ok: missing.length === 0,
    reason: missing.length === 0 ? undefined : `missing: ${missing.join('; ')}`,
    ffmpeg,
    go2rtc,
    chrome,
  };
}

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

/** An ephemeral free TCP port on the loopback interface. */
export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolvePort(port) : reject(new Error('no port'))));
    });
  });
}

/* -------------------------------------------------------------------------- */
/* go2rtc                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A local go2rtc serving one H.264 test-pattern stream.
 *
 * The stream is go2rtc's own `ffmpeg:virtual` source — an ffmpeg `lavfi`
 * `testsrc` encoded with libx264 (`-g 30 -preset ultrafast -tune zerolatency`,
 * i.e. frequent keyframes and no encoder latency, which is what makes the fMP4
 * fragments start playing immediately). go2rtc's `ffmpeg:` sources are piped
 * through its own RTSP module, so that module gets a loopback port too.
 */
export class Go2rtcServer {
  readonly apiPort: number;
  private readonly bin: string;
  private readonly rtspPort: number;
  private readonly configPath: string;
  private readonly dir: string;
  private process: ChildProcess | null = null;
  private stopped = false;

  private constructor(bin: string, apiPort: number, rtspPort: number, dir: string) {
    this.bin = bin;
    this.apiPort = apiPort;
    this.rtspPort = rtspPort;
    this.dir = dir;
    this.configPath = join(dir, 'go2rtc.yaml');
  }

  /** Write the config and start the process, resolving once the API answers. */
  static async launch(bin: string): Promise<Go2rtcServer> {
    const dir = await mkdtemp(join(tmpdir(), 'scc-go2rtc-'));
    const server = new Go2rtcServer(bin, await freePort(), await freePort(), dir);
    await writeFile(server.configPath, server.config(), 'utf8');
    await server.start();
    return server;
  }

  private config(): string {
    const source =
      'ffmpeg:virtual?video=testsrc&size=640x360#video=h264' +
      '#raw=-g 30 -preset ultrafast -tune zerolatency';
    return [
      'api:',
      `  listen: "127.0.0.1:${this.apiPort}"`,
      // The harness page is served by Vite on a different port, and go2rtc
      // answers a cross-origin websocket upgrade with 403 unless told
      // otherwise. In production the card is same-origin behind HA's proxy, so
      // this is a property of the rig, not of the card.
      '  origin: "*"',
      'rtsp:',
      `  listen: "127.0.0.1:${this.rtspPort}"`,
      'webrtc:',
      '  listen: ""',
      'srtp:',
      '  listen: ""',
      'log:',
      '  level: warn',
      'streams:',
      `  ${STREAM_NAME}: "${source}"`,
      '',
    ].join('\n');
  }

  /** Absolute go2rtc websocket URL, exactly what the card would be handed. */
  get wsUrl(): string {
    return `ws://127.0.0.1:${this.apiPort}/api/ws?src=${STREAM_NAME}`;
  }

  /** A real snapshot URL, standing in for HA's signed `camera_proxy` path. */
  get posterUrl(): string {
    return `http://127.0.0.1:${this.apiPort}/api/frame.jpeg?src=${STREAM_NAME}`;
  }

  async start(): Promise<void> {
    if (this.process) return;
    this.stopped = false;
    const child = spawn(this.bin, ['-config', this.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('exit', () => {
      if (this.process === child) this.process = null;
    });
    this.process = child;
    await this.waitUntilResponsive();
  }

  /** Kill the process outright — the socket dies with it (`ws-close`). */
  async kill(): Promise<void> {
    const child = this.process;
    this.process = null;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGKILL');
    await exited;
  }

  /**
   * Freeze the process without closing anything: the TCP connection stays
   * established and the browser keeps a perfectly healthy WebSocket while the
   * frames stop. This is the connected-but-frozen failure the watchdog exists
   * for, and the reason this card was written.
   */
  freeze(): void {
    this.process?.kill('SIGSTOP');
  }

  /** Undo {@link freeze}. */
  thaw(): void {
    this.process?.kill('SIGCONT');
  }

  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // A frozen process ignores SIGKILL until it is resumed.
    this.thaw();
    await this.kill();
    await rm(this.dir, { recursive: true }).catch(() => {});
  }

  private async waitUntilResponsive(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.apiPort}/api/streams`);
        if (response.ok) {
          await response.arrayBuffer();
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(150);
    }
    throw new Error(`go2rtc did not become responsive: ${String(lastError)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Poll `predicate` until it is true, or throw with `message`.
 *
 * Deadlines here are generous on purpose: the point of a test is whether the
 * card recovers *by itself*, not how fast it manages it.
 */
export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${message}`);
    }
    await sleep(intervalMs);
  }
}
