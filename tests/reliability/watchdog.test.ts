import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FrameStallWatchdog,
  WATCHDOG_POLL_INTERVAL_MS,
  type WatchdogOptions,
} from '../../src/reliability/watchdog';
import { WATCHDOG_STALL_TIMEOUT_MS } from '../../src/types';
import { PollingFakeVideo, RvfcFakeVideo } from './doubles';

/** Build an armed watchdog attached to a fresh rVFC-capable video element. */
function armed(overrides: Partial<WatchdogOptions> = {}) {
  const onStall = vi.fn();
  const video = new RvfcFakeVideo();
  const watchdog = new FrameStallWatchdog({ onStall, ...overrides });
  watchdog.attach(video.asVideo());
  watchdog.arm();
  return { onStall, video, watchdog };
}

describe('FrameStallWatchdog (requestVideoFrameCallback path)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses frame callbacks when the element supports them', () => {
    const { watchdog, video } = armed();
    expect(watchdog.usingFrameCallbacks).toBe(true);
    expect(video.pendingFrameCallbacks).toBe(1);
  });

  it('re-arms the stall timer on every presented frame', () => {
    const { onStall, video } = armed();

    // A frame every 4 s keeps the 10 s window open indefinitely.
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(4_000);
      video.presentFrame();
    }

    expect(onStall).not.toHaveBeenCalled();
  });

  it('fires after the stall timeout with no frames', () => {
    const { onStall, watchdog } = armed();

    vi.advanceTimersByTime(WATCHDOG_STALL_TIMEOUT_MS - 1);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(watchdog.stalled).toBe(true);
    expect(watchdog.armed).toBe(false);
  });

  it('measures the window from the last frame, not from arming', () => {
    const { onStall, video } = armed();

    vi.advanceTimersByTime(9_000);
    video.presentFrame();
    vi.advanceTimersByTime(9_000);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_500);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('holds the verdict: never fires twice without a reset', () => {
    const { onStall, video } = armed();

    vi.advanceTimersByTime(60_000);
    expect(onStall).toHaveBeenCalledTimes(1);

    // Even a zombie that starts presenting frames again cannot re-open it.
    video.presentFrame();
    vi.advanceTimersByTime(600_000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('convicts again after reset() + arm(), the post-recovery sequence', () => {
    const { onStall, watchdog } = armed();

    vi.advanceTimersByTime(WATCHDOG_STALL_TIMEOUT_MS);
    expect(onStall).toHaveBeenCalledTimes(1);

    watchdog.reset();
    watchdog.arm();
    expect(watchdog.stalled).toBe(false);
    expect(watchdog.armed).toBe(true);

    vi.advanceTimersByTime(WATCHDOG_STALL_TIMEOUT_MS);
    expect(onStall).toHaveBeenCalledTimes(2);
  });

  it('does not convict while the supervisor says playback is not expected', () => {
    let expected = false;
    const { onStall } = armed({ isPlaybackExpected: () => expected });

    vi.advanceTimersByTime(600_000);
    expect(onStall).not.toHaveBeenCalled();

    expected = true;
    vi.advanceTimersByTime(WATCHDOG_STALL_TIMEOUT_MS);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('does not convict a paused, seeking or ended element', () => {
    const { onStall, video } = armed();

    video.paused = true;
    vi.advanceTimersByTime(60_000);
    expect(onStall).not.toHaveBeenCalled();

    video.paused = false;
    video.seeking = true;
    vi.advanceTimersByTime(60_000);
    expect(onStall).not.toHaveBeenCalled();

    video.seeking = false;
    video.ended = true;
    vi.advanceTimersByTime(60_000);
    expect(onStall).not.toHaveBeenCalled();

    video.ended = false;
    vi.advanceTimersByTime(WATCHDOG_STALL_TIMEOUT_MS);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while disarmed and resumes watching when re-armed', () => {
    const { onStall, watchdog } = armed();

    watchdog.disarm();
    vi.advanceTimersByTime(600_000);
    expect(onStall).not.toHaveBeenCalled();

    watchdog.arm();
    vi.advanceTimersByTime(WATCHDOG_STALL_TIMEOUT_MS);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('follows the element when a re-render swaps the <video>', () => {
    const { onStall, watchdog } = armed();
    const replacement = new RvfcFakeVideo();

    watchdog.attach(replacement.asVideo());
    expect(replacement.pendingFrameCallbacks).toBe(1);

    // The new element is alive, so nothing should fire.
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(4_000);
      replacement.presentFrame();
    }
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(WATCHDOG_STALL_TIMEOUT_MS);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('cancels the outstanding frame callback on detach', () => {
    const { watchdog, video, onStall } = armed();

    watchdog.detach();

    expect(video.cancelCount).toBe(1);
    expect(video.pendingFrameCallbacks).toBe(0);
    vi.advanceTimersByTime(600_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('is inert after destroy()', () => {
    const { watchdog, onStall } = armed();

    watchdog.destroy();
    watchdog.arm();

    vi.advanceTimersByTime(600_000);
    expect(onStall).not.toHaveBeenCalled();
    expect(watchdog.armed).toBe(false);
  });
});

describe('FrameStallWatchdog (currentTime fallback path)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function armedFallback(overrides: Partial<WatchdogOptions> = {}) {
    const onStall = vi.fn();
    const video = new PollingFakeVideo();
    const watchdog = new FrameStallWatchdog({ onStall, ...overrides });
    watchdog.attach(video.asVideo());
    watchdog.arm();
    return { onStall, video, watchdog };
  }

  it('falls back when requestVideoFrameCallback is missing', () => {
    const { watchdog, video } = armedFallback();
    expect(watchdog.usingFrameCallbacks).toBe(false);
    expect(video.listenerCount('timeupdate')).toBe(1);
  });

  it('treats an advancing currentTime as liveness (poll path)', () => {
    const { onStall, video } = armedFallback();

    for (let i = 0; i < 30; i += 1) {
      video.advancePlayback(WATCHDOG_POLL_INTERVAL_MS / 1_000);
      vi.advanceTimersByTime(WATCHDOG_POLL_INTERVAL_MS);
    }

    expect(onStall).not.toHaveBeenCalled();
  });

  it('treats an advancing currentTime as liveness (timeupdate path)', () => {
    // A poll period longer than the test leaves `timeupdate` as the only signal.
    const { onStall, video } = armedFallback({ pollIntervalMs: 10 * 60_000 });

    for (let i = 0; i < 30; i += 1) {
      vi.advanceTimersByTime(4_000);
      video.advancePlayback(4);
      video.emit('timeupdate');
    }

    expect(onStall).not.toHaveBeenCalled();
  });

  it('convicts when currentTime stops advancing', () => {
    const { onStall, video } = armedFallback();

    for (let i = 0; i < 5; i += 1) {
      video.advancePlayback(1);
      vi.advanceTimersByTime(WATCHDOG_POLL_INTERVAL_MS);
    }
    expect(onStall).not.toHaveBeenCalled();

    // Frozen picture: the poll keeps running, currentTime does not move.
    vi.advanceTimersByTime(WATCHDOG_STALL_TIMEOUT_MS);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('ignores a frozen currentTime that is merely paused', () => {
    const { onStall, video } = armedFallback();
    video.paused = true;

    vi.advanceTimersByTime(600_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('removes the timeupdate listener and stops polling on detach', () => {
    const { watchdog, video, onStall } = armedFallback();

    watchdog.detach();

    expect(video.listenerCount('timeupdate')).toBe(0);
    vi.advanceTimersByTime(600_000);
    expect(onStall).not.toHaveBeenCalled();
  });
});
