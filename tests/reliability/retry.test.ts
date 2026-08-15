import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExponentialBackoff, RetryTimer, defaultTimers } from '../../src/reliability/retry';
import {
  REMOUNT_BACKOFF_BASE_MS,
  REMOUNT_BACKOFF_CAP_MS,
  REMOUNT_BACKOFF_JITTER_MAX,
  REMOUNT_BACKOFF_JITTER_MIN,
} from '../../src/types';

/** A deterministic RNG cycling through fixed samples. */
function rng(...samples: number[]): () => number {
  let index = 0;
  return () => samples[index++ % samples.length];
}

describe('ExponentialBackoff', () => {
  it('produces base x factor^n with no jitter when the sample is the maximum', () => {
    const backoff = new ExponentialBackoff({ random: () => 1 });
    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([
      5_000, 10_000, 20_000, 40_000,
    ]);
  });

  it('halves the delay when the sample is the minimum', () => {
    const backoff = new ExponentialBackoff({ random: () => 0 });
    expect([backoff.next(), backoff.next(), backoff.next()]).toEqual([2_500, 5_000, 10_000]);
  });

  it('starts from the spec constants by default', () => {
    const backoff = new ExponentialBackoff({ random: () => 1 });
    expect(backoff.peek()).toBe(REMOUNT_BACKOFF_BASE_MS);
    expect(backoff.next()).toBe(REMOUNT_BACKOFF_BASE_MS);
  });

  it('caps the pre-jitter delay and then stays there forever', () => {
    const backoff = new ExponentialBackoff({ random: () => 1 });
    const delays: number[] = [];
    for (let i = 0; i < 40; i += 1) delays.push(backoff.next());

    expect(Math.max(...delays)).toBe(REMOUNT_BACKOFF_CAP_MS);
    // 5 s x 2^n reaches 640 s at n = 7, so from the 8th delay on it is pinned.
    expect(delays.slice(7)).toEqual(delays.slice(7).map(() => REMOUNT_BACKOFF_CAP_MS));
    expect(backoff.attempts).toBe(40);
  });

  it('keeps every jittered delay inside [0.5, 1.0] of the pre-jitter value', () => {
    const backoff = new ExponentialBackoff({ random: rng(0, 0.25, 0.5, 0.75, 1) });
    for (let i = 0; i < 25; i += 1) {
      const raw = backoff.peek();
      const delay = backoff.next();
      expect(delay).toBeGreaterThanOrEqual(raw * REMOUNT_BACKOFF_JITTER_MIN);
      expect(delay).toBeLessThanOrEqual(raw * REMOUNT_BACKOFF_JITTER_MAX);
    }
  });

  it('honours explicit overrides', () => {
    const backoff = new ExponentialBackoff({
      baseMs: 100,
      factor: 3,
      capMs: 1_000,
      jitterMin: 1,
      jitterMax: 1,
      random: () => 0.42,
    });
    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([
      100, 300, 900, 1_000,
    ]);
  });

  it('re-zeroes on reset, which is what a successful stream does', () => {
    const backoff = new ExponentialBackoff({ random: () => 1 });
    backoff.next();
    backoff.next();
    expect(backoff.attempts).toBe(2);

    backoff.reset();

    expect(backoff.attempts).toBe(0);
    expect(backoff.next()).toBe(5_000);
  });
});

describe('RetryTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the callback after the delay, once', () => {
    const timer = new RetryTimer(defaultTimers);
    const callback = vi.fn();

    timer.schedule(2_000, callback);
    expect(timer.pending).toBe(true);
    expect(timer.delayMs).toBe(2_000);

    vi.advanceTimersByTime(1_999);
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(timer.pending).toBe(false);
    expect(timer.delayMs).toBeUndefined();

    vi.advanceTimersByTime(60_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('replaces a pending callback when re-armed', () => {
    const timer = new RetryTimer(defaultTimers);
    const first = vi.fn();
    const second = vi.fn();

    timer.schedule(2_000, first);
    timer.schedule(5_000, second);
    expect(timer.delayMs).toBe(5_000);

    vi.advanceTimersByTime(10_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('advance() fires immediately and clears the pending timer', () => {
    const timer = new RetryTimer(defaultTimers);
    const callback = vi.fn();

    timer.schedule(600_000, callback);
    expect(timer.advance()).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(timer.pending).toBe(false);

    vi.advanceTimersByTime(600_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('advance() is a no-op when nothing is pending', () => {
    const timer = new RetryTimer(defaultTimers);
    expect(timer.advance()).toBe(false);
  });

  it('lets the callback re-schedule the same timer', () => {
    const timer = new RetryTimer(defaultTimers);
    const seen: number[] = [];
    let round = 0;
    const tick = () => {
      seen.push(++round);
      if (round < 3) timer.schedule(1_000, tick);
    };

    timer.schedule(1_000, tick);
    vi.advanceTimersByTime(3_000);

    expect(seen).toEqual([1, 2, 3]);
    expect(timer.pending).toBe(false);
  });

  it('cancel() drops the callback and is safe to repeat', () => {
    const timer = new RetryTimer(defaultTimers);
    const callback = vi.fn();

    timer.schedule(1_000, callback);
    timer.cancel();
    timer.cancel();

    vi.advanceTimersByTime(10_000);
    expect(callback).not.toHaveBeenCalled();
    expect(timer.pending).toBe(false);
  });

  it('uses the injected timer API rather than the globals', () => {
    const setTimeoutSpy = vi.fn(() => 7 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi.fn();
    const timer = new RetryTimer({
      setTimeout: setTimeoutSpy,
      clearTimeout: clearTimeoutSpy,
      setInterval: vi.fn(() => 0 as unknown as ReturnType<typeof setTimeout>),
      clearInterval: vi.fn(),
    });

    timer.schedule(1_234, () => {});
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_234);

    timer.cancel();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(7);
  });
});
