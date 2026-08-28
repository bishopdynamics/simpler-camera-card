/**
 * `errors.ts` — the one place unknown thrown values become readable text.
 *
 * Every layer of the card catches `unknown`: a rejected websocket command, a
 * DOM event turned into an error, a string thrown by some third-party helper.
 * They all need the same three lines of narrowing to get a message out, and
 * four copies of those lines had drifted apart in exactly the way duplicated
 * error handling always does.
 *
 * This module is deliberately dependency-free — it imports nothing, so any
 * module can import it without risking a cycle. (`types.ts` would have been the
 * other candidate, but it is types-and-constants by charter.)
 */

/**
 * Best-effort human-readable text for anything that was thrown or rejected.
 *
 * The order matters: `Error` first (the common case, and its `message` is the
 * only part worth showing a user), then a bare string, then anything
 * duck-typed with a `message`, and finally `String()` so the result is never
 * `undefined` and never throws.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
