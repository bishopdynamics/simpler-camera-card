# SPEC: Tap-to-go-live (temporary live window on a snapshot card)

- **Status:** in-progress (decisions approved by James 2026-08-27 — "yes to all three, spec it and go")

## Summary

An opt-in behavior for `mode: snapshot` cards: tapping the card temporarily switches it to the real MSE live stream, then reverts to snapshots after a fixed window (`live_duration`, default 60 s). Tapping again reverts early. Promoted from `docs/DEFERRED.md` (deferred out of FEATURE_SPEC_snapshot_mode). Both engines already exist in the card and are constructed/destroyed cleanly, so this is a thin state machine over machinery that is already field-proven.

## Goals

- On a snapshot card with `tap_to_live: true`, a tap starts the MSE live stream; the card reverts to snapshot polling after `live_duration` seconds, or immediately on a second tap.
- The transition never blanks: the current snapshot stays up as the poster while the stream connects; reverting polls a fresh snapshot immediately.
- While temporarily live, a small "LIVE · Ns" countdown pill (existing status-pill styling) shows the window is active; it disappears on revert.
- Full reliability layer runs during the live window (supervisor, watchdog, retries); if the stream never connects, the card shows the normal retry pills and reverts on schedule.
- Zero change to: live-mode cards, snapshot cards without `tap_to_live`, and hold/double-tap actions everywhere.

## Non-Goals

- Extending/renewing the window on further interaction (fixed and predictable beats clever).
- Firing the configured `tap_action` on a `tap_to_live` card (tap is consumed by the toggle; `more-info` stays reachable via `hold_action`).
- A permanent on-screen button, or gesture configurability for the toggle.
- Any meaning for `tap_to_live`/`live_duration` under `mode: live` (ignored, like `refresh_interval`).

## Key Decisions

| Decision | Choice | Rationale / alternatives considered |
| --- | --- | --- |
| Gesture | Tap toggles live; the configured `tap_action` is suppressed on that card; `hold_action`/`double_tap_action` untouched | James's pick (2026-08-27). Alternatives: overlay button (permanent chrome on a chrome-free card); double-tap (undiscoverable on a wall kiosk). |
| Revert policy | Fixed `live_duration` window from go-live (default 60 s, min 5); early revert on tap; revert (not suspend) on `visibility-hidden` — a hidden dashboard returns as a snapshot card | Predictable; a live stream nobody asked to keep should not survive the tab being hidden. No timer extension on interaction. |
| Config surface | `tap_to_live: boolean` (default `false`) + `live_duration: <seconds ≥ 5>` (default 60, fractional allowed); both meaningful only under `mode: snapshot`, silently ignored under `mode: live` | Mirrors the `refresh_interval` precedent exactly. Validation errors for wrong types / below-minimum, like every option. |
| Mechanism | A card-level `_temporaryLive` flag selects which engine `_maybeStart()` builds; go-live = destroy `SnapshotLoop` → start supervisor; revert = stop supervisor → new `SnapshotLoop` (immediate first poll) | Both engines are one-shot and already torn down/rebuilt on `setConfig`/disconnect — reuse that path verbatim. Alternative (running both engines and toggling visibility) rejected: defeats snapshot mode's resource purpose. |
| Indicator | While temp-live **and playing**: "LIVE · Ns" pill (existing `.status` styling), 1 Hz countdown; while connecting/retrying inside the window: the normal live-mode pills | Without it, on a slow refresh you cannot tell the tap worked. James confirmed wanting the countdown. |
| Accessibility | The card stays announced as an interactive button; aria-label reflects the toggle ("go live" / "back to snapshots") | Tap does something meaningful, so `isInteractive` semantics remain true. |
| Version | 0.5.0 (minor bump, dist rebuilt) | User-visible feature; release rules in evergreen handoff. |

## Design

**Config & normalization** (`types.ts`, `card.ts`): `SimplerCameraCardConfig` gains `tap_to_live?: boolean` and `live_duration?: number`; `NormalizedCardConfig` requires both (`false` / `60`). `CONFIG_DEFAULTS` gains `tapToLive: false`, `liveDuration: 60`. Validation: `tap_to_live` must be a boolean when present; `live_duration` a finite number ≥ 5. New const `LIVE_DURATION_MIN_S = 5` if useful for tests/editor.

**Card state machine** (`card.ts`): new `@state() _temporaryLive = false` plus a window-expiry timer and a 1 Hz countdown tick (both cleared on every revert path). Effective mode = `config.mode === 'snapshot' && _temporaryLive ? 'live' : config.mode`; `_maybeStart()` and `render()` consume effective mode everywhere they currently read `config.mode`. Go-live: set flag, `_stopEverything()`, restart via the existing `_maybeStart()` path, arm the window timer. Revert (timer, tap, `visibility-hidden`, `setConfig`, disconnect): clear flag + timers, `_stopEverything()`, `_maybeStart()` (snapshot loop's immediate first poll gives the fresh frame). While connecting, the last `_snapshotUrl` serves as the poster so the transition never blanks.

**Gesture** (`card.ts` / `actions.ts`): on a snapshot card with `tap_to_live`, the tap gesture calls the toggle instead of dispatching `tap_action`'s `hass-action`; hold/double-tap flow through unchanged. Implementation detail (worker's choice, reported): intercept at the card's action-handling seam rather than teaching `ActionController` about modes, if the existing wiring allows.

**Pill** (`card.ts`): in the temp-live window, `_snapshotStatusText` is not used (the card is effectively live); status = normal live pills while not playing, `LIVE · <remaining>s` while playing (remaining rounded up; 1 Hz update).

**Editor** (`editor.ts`): `tap_to_live` boolean selector + `live_duration` number (min 5, `unit_of_measurement: s`) in the Advanced group next to `mode`/`refresh_interval`.

**Docs** (`README.md`): options-table rows + a short subsection under "Snapshot mode" (tap toggles, fixed window, tap_action suppressed — use `hold_action` for more-info).

## Implementation Plan

1. **Contract + config plumbing** — (S) `[serial]`. `tap_to_live`/`live_duration` through types, validation, normalization, defaults; tests. **Owned files:** `src/types.ts`, `src/card.ts` (normalizeConfig only), `tests/card.test.ts`, plus mechanical `NormalizedCardConfig` fixture updates in `tests/actions.test.ts` / `tests/reliability/doubles.ts`.
2. **Temp-live state machine + gesture + pill** — (M) `[serial]`. Card flag/timers/effective-mode, engine swap on toggle, all revert paths, tap interception, LIVE countdown pill; tests (fake timers) for: toggle both ways, window expiry, early revert, hidden-revert, tap_action suppressed only when active, hold/double-tap unaffected, no-blank poster behavior, `setConfig`/disconnect cleanup, options ignored under `mode: live`. **Owned files:** `src/card.ts`, `src/actions.ts` (only if the seam requires it), `tests/card.test.ts`, `tests/actions.test.ts`.
3. **Editor + docs + release** — (S) `[serial]`. Editor fields + tests, README, version 0.5.0 (`package.json`, `src/index.ts`), dist rebuild. **Owned files:** `src/editor.ts`, `tests/editor.test.ts`, `README.md`, `package.json`, `src/index.ts`, `dist/`.

Verification per slice: `make check`. Completion gate: James field-tests on the kiosk.

## Open Questions

-

## Deferred / Follow-ups

-

## Change Log

- 2026-08-27 — created and approved in one step (gesture, revert policy, and indicator decided in discussion with James); promoted from `docs/DEFERRED.md`.
