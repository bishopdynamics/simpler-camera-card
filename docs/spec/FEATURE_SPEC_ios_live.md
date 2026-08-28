# SPEC: iOS live playback (ManagedMediaSource)

- **Status:** in-progress (approved by James 2026-08-28)

## Summary

Live playback is dead on iPhones (official HA app = WKWebView = Safari engine): iOS has never shipped the standard `MediaSource` API, only **`ManagedMediaSource`** (iOS 17.1+). `MsePlayer.mount()` finds `globalThis.MediaSource` undefined, dies `media-error`, and the supervisor retries forever — the observed endless "Connecting…". Snapshot mode works (plain `<img>`). Fix: support `ManagedMediaSource` the way go2rtc's own `video-rtc.js` and Frigate's UI do, plus a clean capability message for browsers that have neither. Promotes the DEFERRED item "Safari/iOS polish (ManagedMediaSource, jump-to-live quirks)" — the MMS half; broader Safari polish stays deferred.

## Goals

- Live MSE playback works in the official HA iOS app on iOS 17.1+ (and Safari on iPhone), surviving the same reconnect matrix as Chromium.
- A browser with neither `MediaSource` nor `ManagedMediaSource` shows a clear, permanent capability message (naming `mode: snapshot` as the alternative) instead of an infinite retry loop.
- Zero behavior change on Chromium (the field-proven path).

## Non-Goals

- Full Safari/iOS polish (jump-to-live quirks, ManagedMediaSource `startstreaming`/`endstreaming`-driven append gating beyond the minimum, AirPlay). Remainder stays in DEFERRED.
- iOS < 17.1 (no MSE variant exists; snapshot mode is the answer, and the capability message says so).
- HLS or any new transport.

## Key Decisions

| Decision | Choice | Rationale / alternatives considered |
| --- | --- | --- |
| API selection | Prefer `ManagedMediaSource` when present, else `MediaSource` | Matches upstream go2rtc `video-rtc.js` and WebKit guidance (MMS gives the UA power/buffer management; on iPadOS/macOS where both exist, MMS is the recommended one). Alternative (MediaSource-first) leaves iPad on the legacy path for no benefit. |
| Attachment | MMS: `video.disableRemotePlayback = true` + `video.srcObject = ms`; classic: object URL, unchanged | `disableRemotePlayback` is required for MMS to open; `srcObject` is the attachment upstream uses and works on every MMS-carrying WebKit, sidestepping object-URL-for-MMS version differences. Teardown must clear whichever attachment was used. |
| Codec probing | `isTypeSupported` on the *selected* constructor | The existing `MediaSourceConstructor` seam already models this; the chosen impl answers for itself. |
| Capability absence | Card-level preflight before starting the supervisor: neither constructor present → permanent error overlay "Live view needs MediaSource (iOS 17.1+). Use mode: snapshot." — supervisor never starts | Retrying can never succeed; burning the backoff ladder on an impossibility is noise. Preflight in the card (not the player) so no socket is ever opened. Snapshot mode and the visual editor remain fully usable. |
| MMS streaming events | Minimum viable: none required for correctness (appends are legal regardless; eviction shows up as ordinary buffered-range changes, which the range-aware hygiene from round 1 already handles). A worker finding upstream evidence to the contrary stops and reports. | Keeps the change surface small on a reliability-critical module. |
| Verification | Unit tests via the existing `mediaSourceImpl` seam (fake MMS ctor asserting `disableRemotePlayback`/`srcObject` path); Chromium integration suite must stay green; real-device acceptance is James's iPhone | happy-dom has no MMS; the seam exists precisely for this. |
| Version | 0.7.1 | Fix-shaped feature; no config surface change. |

## Design

`mse-player.ts`: selection helper `pickMediaSourceImpl()` returning `{ ctor, managed: boolean }` from `globalThis.ManagedMediaSource ?? globalThis.MediaSource` (deps seam `mediaSourceImpl` keeps priority, gaining an optional `managed` hint for tests). `attachMediaSource` branches on `managed` for the attachment (srcObject + disableRemotePlayback vs object URL); `destroy()` clears `srcObject`/object URL symmetrically. Codec filtering calls the selected ctor's `isTypeSupported`. `card.ts`: preflight `hasMediaSourceSupport()` consulted in `_startSupervisor`'s path — absent → render the permanent capability status (reuse the error-overlay presentation), never construct the supervisor; snapshot/tap-to-live paths unaffected (a tap on a tap-to-live card in an unsupported browser shows the same message for the window's duration — acceptable, documented in tests). README: Requirements table gains the iOS 17.1+ note for live mode; Browser row updated (no longer "not a v1 criterion" — iOS live is supported on 17.1+).

## Implementation Plan

1. **MMS support + preflight + tests** — (M) `[serial]`. Selection, attachment, teardown, codec probing, card preflight + capability message; unit tests for both attachment paths, teardown symmetry, preflight rendering. **Owned files:** `src/player/mse-player.ts`, `src/card.ts`, `src/types.ts` (only if the seam type needs the `managed` hint), `tests/player/mse-player.test.ts`, `tests/card.test.ts`.
2. **Docs + release** — (S) `[serial]`. README requirements/browser rows, version 0.7.1, dist rebuild. **Owned files:** `README.md`, `package.json`, `package-lock.json`, `src/index.ts`, `dist/`.

Completion gate: James verifies live playback on his iPhone in the HA app.

## Open Questions

-

## Deferred / Follow-ups

- Remaining Safari/iOS polish (jump-to-live quirks, MMS streaming-event-driven append gating, AirPlay behavior) — stays in `docs/DEFERRED.md` (reworded to drop the MMS half).

## Change Log

- 2026-08-28 — created mid-release-review ("side quest") from James's field report: live view loops "Connecting…" in the official iOS HA app; root cause confirmed in code (no ManagedMediaSource support).
