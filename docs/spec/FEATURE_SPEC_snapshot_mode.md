# SPEC: Snapshot Mode (low-framerate still-image view)

- **Status:** draft

## Summary

An optional per-card mode that replaces the MSE live stream with a still image refreshed on a configurable interval (`refresh_interval`, seconds — e.g. every 4 s ≈ 0.25 FPS). Motivation: low-resource kiosks. A true client-side FPS cap on an MSE H.264 stream is not achievable (the decoder must decode reference chains regardless of what is rendered), so the honest low-resource mechanism is polling stills: no WebSocket, no MediaSource, no video decode pipeline — a JPEG swap every few seconds. This promotes the ROOT_SPEC deferred item "Snapshot-refresh transport (ultra-low-power camera_proxy cycling)".

## Goals

- `mode: snapshot` shows a live-ish still of the camera, refreshed every `refresh_interval` seconds, indefinitely, with kiosk-grade robustness (a failed refresh never kills the loop; recovery is automatic and silent).
- Overlay, tap/hold/double-tap actions, and `aspect_ratio` behave identically to live mode.
- Zero change to live-mode behavior; `mode: live` (the default) is byte-for-byte the current pipeline.
- Visual editor covers the new options.

## Non-Goals

- Low-FPS *video* (smooth motion at reduced rate). That requires server-side transcoding; users who want it can already define an ffmpeg `fps=`-filtered stream in go2rtc and select it with the existing `stream:` option — documented, not built.
- Client-side filtering/decimation of the MSE stream (fragile fMP4 rewriting; against the project's reliability ethos).
- Automatic mode switching (e.g. by device heuristics), or mixing modes in one card (tap-to-go-live is deferred).
- Sub-second refresh intervals (at ≥1 FPS the MSE stream is the better tool).

## Key Decisions

| Decision | Choice | Rationale / alternatives considered |
| --- | --- | --- |
| Mechanism | Poll HA's signed snapshot URL via the existing `EndpointResolver.resolvePosterUrl()` (camera `entity_picture`, re-resolved every tick since its `access_token` rotates ~5 min) | Already built, already same-origin/authed, already field-proven as the poster. Alternatives: Frigate `latest.jpg` via the integration proxy (second URL scheme for no gain); client-side MSE frame-dropping (impossible without decoding — rejected); go2rtc ffmpeg transcode (burns server CPU 24/7 per stream; stays available via `stream:` as a power-user escape hatch). |
| Config surface | `mode: live \| snapshot` (default `live`) + `refresh_interval: <seconds ≥ 1>` (default 5, fractional allowed, only meaningful in snapshot mode) | Explicit mode over a magic `max_fps` that silently switches technologies — stills are a different thing than video and the config should say so. Seconds over FPS per James (2026-08-27): "every 4 seconds" reads better than "0.25 FPS" at these rates. Invalid values fail validation like every other config error. |
| Snapshot loop owner | New small module `src/snapshot.ts` (`SnapshotLoop`), driven by the card; the `StreamSupervisor`/player/watchdog stack is **not** constructed in snapshot mode | The supervisor's state machine (tiers, watchdog, handshake) is stream-shaped; a poll loop needs none of it. A timer + retry-next-tick is the whole reliability story. Alternative (snapshot as a `LivePlayer` under the supervisor) rejected: forces stream semantics onto a loop that has no "dead" state. |
| Flicker-free swap | Preload each refresh into a detached `Image`; swap the visible `<img src>` only on successful load | Never blanks or tears; a failed load leaves the last good frame up. |
| Failure policy | Keep last good frame; retry on the next tick, forever. After 3 consecutive failures show the existing unobtrusive status indicator (stale); config-class endpoint errors (`entity-not-found`, …) render the same error overlay as live mode | Kiosk semantics — never a dead end, never a scary flash for one dropped poll. Uses the attribute-cache fallback from v0.1.1 automatically (it lives in the resolver). |
| Lifecycle | Pause polling while `document.hidden`; on visible / `pageshow` / `online` / hass-reconnect, refresh immediately and resume the timer | Same events the card already listens to; an interval timer is inherently freeze-proof (next tick after resume just runs). |
| Scope of `refresh_interval` | Snapshot mode only; the live-mode down-poster keeps `POSTER_REFRESH_INTERVAL_MS` (10 s) | Keeps the option's meaning crisp; changing poster cadence is unrelated scope. |
| Version | 0.4.0 (minor bump, dist rebuilt) | New user-visible feature; release rules in evergreen handoff. |

## Design

**Config & normalization** (`types.ts`, `card.ts`): `SimplerCameraCardConfig` gains `mode?: 'live' | 'snapshot'` and `refresh_interval?: number`; `NormalizedCardConfig` makes both required (`live` / `5`). `VIEW_MODES` const for validation; `refresh_interval` must be a finite number ≥ 1 (else `ConfigValidationError`). New const `SNAPSHOT_STALE_AFTER_FAILURES = 3`.

**SnapshotLoop** (`src/snapshot.ts`): constructed with `{ getHass, getConfig, resolver, onFrame(url), onStale(consecutiveFailures), onEndpointError(err) }`. `start()` ticks immediately then every `refresh_interval * 1000` ms; each tick awaits `resolvePosterUrl`, preloads, then calls `onFrame`. Load/resolve failure increments a consecutive-failure counter (reset on success) and calls `onStale` at the threshold. `pause()`/`resume()` for visibility (resume ticks immediately). `destroy()` idempotent. Overlapping ticks are prevented (skip if a tick is in flight — relevant when interval is short and the network is slow).

**Card integration** (`card.ts`): `_maybeStart()` branches on `config.mode` — `live` builds the supervisor exactly as today; `snapshot` builds a `SnapshotLoop` and renders an `<img>` (same slot/geometry as the `<video>`, honoring `aspect_ratio`) with overlay and actions unchanged. Visibility/page-resume/hass-reconnect handlers route to `pause()`/`resume()`/immediate-refresh instead of supervisor events. `setConfig` mode changes tear down and rebuild (already the pattern).

**Editor** (`editor.ts`): add `mode` select (`live`/`snapshot`) and `refresh_interval` number field (min 1, `unit_of_measurement: s`) to the `getConfigForm` schema; `flatten: true` grouping as established.

**Docs** (`README.md`): new options documented; a note explaining stills-vs-video honestly, plus the go2rtc `fps=` transcode escape hatch for real low-FPS video.

## Implementation Plan

1. **Contract + config plumbing** — (S) `[serial]`. `mode`/`refresh_interval` through types, validation, normalization, defaults; `SNAPSHOT_STALE_AFTER_FAILURES`; tests for validation/normalization. **Owned files:** `src/types.ts`, `src/card.ts` (normalizeConfig only), `tests/card.test.ts`.
2. **SnapshotLoop + card integration** — (M) `[serial]`. `src/snapshot.ts` with unit tests (fake timers, fake resolver: cadence, preload-swap, failure/stale, pause/resume, overlap guard, destroy); card branch, `<img>` rendering, lifecycle routing; card-level tests for mode branching. **Owned files:** `src/snapshot.ts`, `src/card.ts`, `tests/snapshot.test.ts`, `tests/card.test.ts`.
3. **Editor + docs + release** — (S) `[serial]`. Editor schema + tests, README, version 0.4.0 in `package.json` + `src/index.ts`, dist rebuild. **Owned files:** `src/editor.ts`, `tests/editor.test.ts`, `README.md`, `package.json`, `src/index.ts`, `dist/`.

Verification per slice: `make check` (lint, typecheck, vitest, build). Post-merge: orchestrator visual check via mcp-browser against James's HA when available; field acceptance on the kiosk is the completion gate.

## Open Questions

-

## Deferred / Follow-ups

- **Tap-to-go-live:** snapshot mode by default, tapping temporarily switches the card to the MSE live stream (with a revert timeout). Interacts with `tap_action` config — needs its own discussion. (James, 2026-08-27: "an interesting feature we should come back to".)

## Change Log

- 2026-08-27 — created from discussion with James (snapshot mechanism confirmed; interval-in-seconds confirmed; tap-to-go-live deferred). Promotes ROOT_SPEC deferred item "Snapshot-refresh transport".
