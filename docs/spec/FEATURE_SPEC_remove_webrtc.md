# SPEC: Remove WebRTC Transport

- **Status:** in-progress

## Summary

Remove the opt-in WebRTC transport entirely and focus the card exclusively on MSE. Field experience (2026-08-27): WebRTC could not be made to connect on James's LAN even after configuring go2rtc `candidates` — the direct browser→Frigate `:8555` path is fragile by nature (Docker networking, advertised candidates, no STUN by design), while MSE has run flawlessly for 8+ days on the 24/7 kiosk. James's call: MSE is the ideal mode; the WebRTC code, config option, and editor dropdown are dead weight. This reverses ROOT_SPEC's "WebRTC as opt-in low-latency mode" goal.

## Goals

- No WebRTC code, config surface, or docs remain: `transport` option gone from `types.ts`, editor, README.
- Existing dashboards with `transport: mse` or `transport: webrtc` in YAML keep working untouched (the key degrades to an ignored unknown key, per the card's existing unknown-key policy).
- Smaller bundle; unchanged reliability behavior for MSE.

## Non-Goals

- No MSE behavior changes whatsoever — this is pure removal.
- No removal of the go2rtc client's generic message plumbing beyond what only WebRTC used.

## Key Decisions

| Decision | Choice | Rationale / alternatives considered |
| --- | --- | --- |
| Old `transport:` keys in existing YAML | Silently ignored, like every other unknown key | The card already ignores Lovelace-injected unknowns rather than rejecting; rejecting or warning would break/spam dashboards that worked yesterday. README's changelog note is the migration doc. |
| `PlayerFactory` shape | `createPlayer()` takes no argument | Only one player exists; keeping a vestigial parameter invites drift. |
| go2rtc client | Keep the shared JSON/binary lane client; remove only WebRTC-specific message types/handling if any are separable | The MSE player is built on it. |
| Future low-latency need | Deferred: re-introduce via HA-native signalling (`camera/webrtc/offer`), not via direct `:8555` | The direct-candidate path is what failed in the field; HA-native signalling proxies through HA's origin like everything else the card does. Mirrored to `docs/DEFERRED.md`. |
| Version | 0.3.0 on acceptance | Feature-level change (removal), same cadence as 0.2.0. |

## Design

Pure excision: delete `src/player/webrtc-player.ts` and its tests; drop `Transport`/`TRANSPORTS` and the `transport` key from `types.ts` config interfaces, `CONFIG_DEFAULTS`, and `normalizeConfig`; simplify `PlayerFactory`/`createPlayer` and the card's supervisor wiring; remove the transport field from the editor schema/labels/helpers and its tests; strip WebRTC rows/sections from README (install/config/troubleshooting) and the integration rig. Everything else is untouched.

## Implementation Plan

1. **Remove WebRTC** — (M) `[serial]`
   - Owned files: `src/player/webrtc-player.ts` (delete), `tests/player/webrtc-player.test.ts` (delete), `src/types.ts`, `src/card.ts`, `src/editor.ts`, `src/reliability/supervisor.ts`, `src/player/go2rtc-client.ts`, `tests/**` (affected tests), `tests/integration/rig.ts`, `README.md`.
   - Verification: `make check`; orchestrator additionally runs `make test-integration` post-merge.
2. **Version bump + field check** — (S) `[serial]`, orchestrator-only: bump to 0.3.0, rebuild dist, James verifies editor no longer shows the dropdown and the kiosk still streams.

## Open Questions

- None.

## Deferred / Follow-ups

- Re-introduce low latency via HA-native WebRTC signalling (`camera/webrtc/offer`) if ever needed — supersedes the old ":8555 fallback" deferred item.

## Change Log

- 2026-08-27 — created; approved by James's direct instruction ("remove webrtc support, focus exclusively on MSE"); slice 1 dispatched.
- 2026-08-27 — slice 1 done (Opus worker, orchestrator-verified: 243 unit + 3 integration tests green). v0.3.0 shipped; awaiting James's field check.
