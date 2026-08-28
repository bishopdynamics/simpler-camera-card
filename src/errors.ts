/**
 * `errors.ts` — turning unknown thrown values into readable text, plus the two
 * things every module that logs needs.
 *
 * Every layer of the card catches `unknown`: a rejected websocket command, a
 * DOM event turned into an error, a string thrown by some third-party helper.
 * They all need the same three lines of narrowing to get a message out, and
 * those lines used to be copied into each module and drift apart in exactly the
 * way duplicated error handling always does. The console prefix and the tiny
 * logging surface live here for the same reason: they were declared five times
 * over, once per module that logs.
 *
 * This module is deliberately dependency-free — it imports nothing, so any
 * module can import it without risking a cycle. (`types.ts` would have been the
 * other candidate, but it is types-and-constants by charter.)
 */

/** Prefix on every console line, so field logs are greppable. */
export const LOG_PREFIX = '[simpler-camera-card]';

/**
 * The logging surface the card's long-lived engines use. Injectable so tests
 * can assert on it quietly; `console` satisfies it as-is.
 */
export interface Logger {
  info(...args: unknown[]): void;
}

/** Options for {@link describeError}. */
export interface DescribeErrorOptions {
  /**
   * Prefix an `Error` with its `name` (`"QuotaExceededError: …"`). Useful in a
   * diagnostic log line where the error *class* is the interesting part;
   * user-facing text wants the bare message, which is the default.
   */
  withName?: boolean;
}

/**
 * Best-effort human-readable text for anything that was thrown or rejected.
 *
 * The order matters: `Error` first (the common case, and its `message` is the
 * only part worth showing a user), then a bare string, then anything
 * duck-typed with a `message`, and finally `String()` so the result is never
 * `undefined` and never throws.
 */
export function describeError(error: unknown, options: DescribeErrorOptions = {}): string {
  if (error instanceof Error) {
    return options.withName ? `${error.name}: ${error.message}` : error.message;
  }
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
