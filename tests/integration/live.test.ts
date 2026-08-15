/**
 * `tests/integration/live.test.ts` — the card against a real go2rtc.
 *
 * Everything the unit tests have to mock is real here: the go2rtc WebSocket
 * protocol, the fMP4 stream, `MediaSource`, the browser's decoder, and the
 * failure modes (a killed server, a frozen one). What is asserted is the whole
 * point of the card: **it comes back by itself**.
 *
 * Run with `make test-integration`. It is deliberately excluded from
 * `make check`: it needs ffmpeg, a go2rtc binary and a Chromium with H.264, and
 * it takes about a minute. Missing tooling skips the suite rather than failing
 * it.
 */

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import type { HarnessProbe } from './harness';
import { Go2rtcServer, REPO_ROOT, freePort, probeTooling, sleep, waitFor } from './rig';

const tooling = probeTooling();

if (!tooling.ok) {
  // Written straight to stderr: this has to be visible during collection, when
  // no test is running for the reporter to attribute console output to.
  process.stderr.write(
    `\n[integration] SKIPPED — ${tooling.reason}\n` +
      `[integration] the unit suite (\`make check\`) covers everything else.\n\n`,
  );
}

/** Generous: recovery correctness is what matters, not its speed. */
const RECOVERY_DEADLINE_MS = 90_000;
/** Watchdog window is 10 s; allow for conviction plus a teardown. */
const STALL_DEADLINE_MS = 40_000;

describe.skipIf(!tooling.ok)('go2rtc live integration', () => {
  let go2rtc: Go2rtcServer;
  let server: ViteDevServer;
  let browser: Browser;
  let page: Page;
  let capabilities: HarnessProbe | undefined;

  beforeAll(async () => {
    go2rtc = await Go2rtcServer.launch(tooling.go2rtc as string);

    // Vite serves the harness page and transpiles `src/*.ts` on the fly, so the
    // browser runs the same modules the bundle ships.
    const port = await freePort();
    server = await createServer({
      configFile: false,
      root: REPO_ROOT,
      logLevel: 'warn',
      server: { host: '127.0.0.1', port, strictPort: true },
    });
    await server.listen();

    browser = await chromium.launch({
      executablePath: tooling.chrome as string,
      headless: true,
      args: [
        // Muted autoplay is allowed anyway; this removes the gesture
        // requirement entirely so a failure means a *real* failure.
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    page = await browser.newPage();
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('[simpler-camera-card]')) console.log(`  [page] ${text}`);
    });
    page.on('pageerror', (error) => console.log(`  [page error] ${error.message}`));

    const url =
      `http://127.0.0.1:${port}/tests/integration/harness.html` +
      `?ws=${encodeURIComponent(go2rtc.wsUrl)}&poster=${encodeURIComponent(go2rtc.posterUrl)}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.__harness));
    capabilities = await probe(page);
    if (!capabilities.mseH264) {
      console.warn(
        `\n[integration] SKIPPED — ${tooling.chrome} cannot decode H.264 over MSE; ` +
          `set SCC_CHROME_PATH to a Google Chrome build.\n`,
      );
    }
  }, 120_000);

  afterAll(async () => {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    await go2rtc?.dispose();
  });

  function requireCodec(ctx: TestContext): void {
    if (!capabilities?.mseH264) ctx.skip();
  }

  it(
    'connects to real go2rtc over the real WS protocol and advances frames',
    async (ctx) => {
      requireCodec(ctx);
      await waitForPlaying(page, RECOVERY_DEADLINE_MS);

      const first = await probe(page);
      await sleep(1_500);
      const second = await probe(page);

      expect(second.currentTime).toBeGreaterThan(first.currentTime);
      expect(second.videoWidth).toBe(640);
      expect(second.paused).toBe(false);
      // Live video means no degraded-state UX on screen.
      expect(second.status).toBeNull();
      expect(second.poster).toBeNull();
    },
    RECOVERY_DEADLINE_MS + 30_000,
  );

  it(
    'recovers by itself after go2rtc is killed and restarted',
    async (ctx) => {
      requireCodec(ctx);
      await waitForPlaying(page, RECOVERY_DEADLINE_MS);
      await page.evaluate(() => window.__harness.reset());

      await go2rtc.kill();

      await waitFor(
        async () => (await probe(page)).status !== null,
        20_000,
        'the card to notice the dead socket',
      );
      const down = await probe(page);
      // Degraded UX: poster back on screen, status explains the wait.
      expect(down.poster).not.toBeNull();
      expect(down.status).toMatch(/Reconnecting/);
      expect(down.log.join('\n')).toMatch(/stream died: ws-(close|error)/);

      await go2rtc.start();
      await waitForPlaying(page, RECOVERY_DEADLINE_MS);

      const back = await probe(page);
      expect(back.status).toBeNull();
      expect(back.log.join('\n')).toContain('MSE playback started');
    },
    RECOVERY_DEADLINE_MS + 60_000,
  );

  it(
    'convicts a frozen-but-connected stream and recovers when it thaws',
    async (ctx) => {
      requireCodec(ctx);
      await waitForPlaying(page, RECOVERY_DEADLINE_MS);
      await page.evaluate(() => window.__harness.reset());

      // SIGSTOP: the socket stays established, the frames stop. Nothing in the
      // chain sends keepalives, so only the frame watchdog can catch this.
      go2rtc.freeze();
      try {
        await waitFor(
          async () => (await probe(page)).log.some((line) => line.includes('stream died: stall')),
          STALL_DEADLINE_MS,
          'the watchdog to convict the frozen stream',
        );
      } finally {
        go2rtc.thaw();
      }

      const convicted = await probe(page);
      expect(convicted.log.join('\n')).toContain('stream died: stall');

      await waitForPlaying(page, RECOVERY_DEADLINE_MS);
      expect((await probe(page)).status).toBeNull();
    },
    STALL_DEADLINE_MS + RECOVERY_DEADLINE_MS + 60_000,
  );
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function probe(page: Page): Promise<HarnessProbe> {
  return page.evaluate(() => window.__harness.probe());
}

/**
 * "Playing" the way a viewer would judge it: no status pill, no poster, and
 * `currentTime` genuinely moving — an element that merely *intends* to play
 * does not count.
 */
async function waitForPlaying(page: Page, timeoutMs: number): Promise<void> {
  let previous = -1;
  await waitFor(
    async () => {
      const state = await probe(page);
      const advancing = state.currentTime > previous && state.currentTime > 0;
      previous = state.currentTime;
      return advancing && state.status === null && state.poster === null;
    },
    timeoutMs,
    'the card to play live frames',
    500,
  );
}
