import { defineConfig } from 'vitest/config';

/**
 * Runner config for the go2rtc integration suite (`make test-integration`).
 *
 * Separate from `vite.config.ts` because this suite is nothing like the unit
 * tests: it runs in Node (it spawns processes and drives a real browser through
 * Playwright), it needs minutes rather than milliseconds, and it must never run
 * concurrently with itself — one go2rtc, one browser, one shared page.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 180_000,
    teardownTimeout: 30_000,
    fileParallelism: false,
    // Real servers and real processes: a hung test should say so, not hang CI.
    pool: 'forks',
  },
});
