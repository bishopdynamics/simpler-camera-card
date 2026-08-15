# SPEC: Simpler Camera Card

- **Status:** approved
- **Addenda:** (none)

## Summary

A Home Assistant Lovelace custom card showing a single Frigate camera's live view, built for reliability on long-running dashboards (wall kiosks). It replaces Advanced Camera Card for this use case: ACC has grown complex and its streams no longer recover from network blips. Research (see `docs/idea/research-notes.md`) verified the root causes in ACC's source and confirmed that *no* card in the ecosystem detects a connected-but-frozen stream — the reliability layer here is the card's reason to exist.

## Goals

- Live view of one Frigate camera per card, via go2rtc, streaming indefinitely.
- **Automatic recovery from every observed failure class**: network blip, HA restart (signing key rotation), Frigate/go2rtc restart, frozen-but-connected stream, tab freeze/unfreeze, HA websocket reconnect. Recovery requires no user interaction, ever.
- Efficient default transport (MSE; hardware decode, one WebSocket), with WebRTC as opt-in low-latency mode.
- Configurable tap/hold/double-tap actions with HA-standard semantics (default: more-info).
- Sub-stream selection via config (`<camera>_sub` convention).
- Optional overlay: camera name or custom text.
- Simple YAML config that fits on one screen.

## Non-Goals

- Multi-camera layouts, carousels, grids (one camera per card; users compose with HA layout).
- Casting/AirPlay, PTZ, timelines, event/recording browsing, menus, status bars, fullscreen UI.
- 2-way audio / microphone.
- Audio playback in v1 (muted live video only; audio is a follow-up).
- Supporting cameras that are not reachable through go2rtc (no HLS/jsmpeg/generic-camera transports).
- iOS/Safari-first polish. Primary target is Chromium; the design avoids Chromium-only APIs where cheap, but Safari quirks are not v1 acceptance criteria.

## Key Decisions

| Decision | Choice | Rationale / alternatives considered |
| --- | --- | --- |
| Build vs fork | Build fresh; borrow logic patterns (with attribution) from MIT sources (ACC rc.4 reliability code, go2rtc `video-rtc.js`, Frigate `MsePlayer.tsx`) | ACC's complexity is the source of its bugs; its recovery breakages are in its own modifications. All sources MIT. |
| Language/stack | TypeScript + Lit, bundled to a single `dist/simpler-camera-card.js` | HA frontend convention. Alternatives: plain custom elements (more hand-rolling), fork (rejected). |
| Bundler / tests | Vite (library mode) + Vitest (happy-dom) | Standard, fast, one config each. Alternative: Rollup directly (Vite wraps it anyway). |
| go2rtc client | **Reimplement the go2rtc WS protocol in TypeScript** (~300 lines; protocol is 4 message types, documented in go2rtc `internal/api/ws/README.md`) | Vendoring `video-rtc.js` imports its known defects (unbounded 2 MB buffer, swallowed errors, no watchdog) as untyped JS. Owning it typed lets the reliability layer hook every event. Alternative (fallback if the wall is hit): vendor upstream `video-rtc.js` faithfully + wrap. |
| Endpoint | frigate-hass-integration HA proxy: `/api/frigate/<client_id>/go2rtc/ws/api/ws?src=<stream>`; `client_id` and default stream name from the camera entity's `client_id`/`camera_name` attributes | Same-origin, no CORS/mixed-content/ports; integration confirmed installed. Fallbacks (config-overridable base URL for direct Frigate nginx access) considered but not default. |
| Auth | Sign the WS path via `auth/sign_path` **on every (re)connect attempt**; never cache the signed URL | ACC's cached-24 h URL is root cause #4 of its never-recover behavior; re-signing survives HA restarts. |
| Default transport | MSE (fMP4 over WebSocket) | Within a hair of WebRTC on client CPU (both hardware decode), vastly more observable (bytes + `progress` events on one socket), reconnect = new WebSocket, no ICE/NAT/STUN. What Frigate's own UI uses. |
| WebRTC mode | Opt-in `transport: webrtc`, signalled over the **same go2rtc WS** (`webrtc/offer|answer|candidate`); media direct browser→Frigate `:8555`; `iceServers: []` by default (LAN) | One signalling code path shared with MSE. Alternative considered: HA-native `camera/webrtc/offer` — zero network config but adds a second go2rtc hop (HA's bundled go2rtc re-pulls from Frigate) and a different signalling stack; revisit if `:8555` reachability is a problem in the field. |
| Stall detection | `requestVideoFrameCallback` watchdog: every presented frame re-arms a 10 s timer; timer fires while playback is expected (visible, not paused/seeking) ⇒ stream declared dead regardless of what transport state claims | The gap every existing implementation shares; modeled on ACC rc.4's `FrameStallWatchdog` (MIT, designed but unwired). rVFC is fine on Chromium (primary target); if rVFC is unavailable, fall back to a `timeupdate`/`currentTime`-delta poll. |
| Retry policy | Two-tier: 3 fast in-place retries at 2 s → full player remount with jittered exponential backoff (5 s base, ×2, cap 600 s, jitter ×[0.5,1.0]), **retrying forever** | Kiosk semantics: never give up. Jitter avoids thundering herd with 2–4 cards per view. From ACC rc.4 constants. |
| ICE state handling (WebRTC mode) | `disconnected` is NOT terminal (wait; the watchdog catches it if frames stop); only `failed` triggers reconnect | ACC rc.4's documented rule; treating `disconnected` as fatal turns blips into churn. |
| Reconnect triggers | (a) WS close/error, (b) media `error`, (c) watchdog stall, (d) `hass.connected` false→true edge, (e) `resume`/`pageshow`/`online` after freeze, (f) MSE handshake timeout (5 s) | Covers all failure classes incl. the no-keepalive blackhole (nothing in the chain sends pings — watchdog is the only detector). |
| Lifecycle | `document.visibilitychange` hidden ⇒ teardown after 5 s grace; visible ⇒ reconnect. Also handle `pagehide`/`freeze`/`resume`. `connectedWhileHidden` left `false` (HA removes hidden cards from DOM; reconnect is cheap) | Frozen tabs never run pending timers — recovery must key off lifecycle events, not timers alone. Matches upstream go2rtc behavior ACC disabled. |
| MSE hygiene | Bounds-checked staging buffer; surface (never swallow) `appendBuffer` errors; keep ≤5 s back-buffer; >10 s buffered ⇒ declare broken; live-edge catch-up via seek ("jump to live"), not `playbackRate` chase | Fixes upstream `video-rtc.js`'s `RangeError` stall and slow-motion pathologies; rate-chase re-buffers on WebKit. |
| `play()` handling | Card always calls `video.play()` after (re)connect; on rejection retry muted | ACC's gutted `play()` is root cause #1. Card is muted in v1 anyway, so autoplay policy is satisfied. |
| Poster / degraded state | While connecting/reconnecting, show the latest snapshot (signed `/api/camera_proxy/<entity>`) dimmed with a subtle status indicator; refresh snapshot every 10 s while down | Blips look graceful instead of black. Camera `access_token` rotates every 5 min ⇒ use signed path, fetched per attempt. |
| Escape hatch | Optional `reload_after_minutes_down: N` config — full `location.reload()` after N minutes continuously failed (default: off) | The only remedy the community trusts today; bounded and opt-in. |
| Actions | Fire HA's `hass-action` event with `{config, action}`; no `custom-card-helpers` dependency (lagging vendored snapshot); types from `home-assistant-js-websocket` (dev-dep only) | Delegates confirmations/more-info/navigate/perform-action to HA (≥2023.7). Default tap = more-info — the behavior the user misses from builtin cards. |
| Capability checks | Never read `frontend_stream_type` (removed 2025.6) | Card doesn't need `camera/capabilities` either — it talks to go2rtc directly. |
| Distribution | Single-file bundle; HACS-compatible repo layout (`dist/simpler-camera-card.js` + `hacs.json`); manual `/local/` install documented with `?v=` cache-busting | Standard practice; Chromium kiosks cache aggressively. |
| Min versions | HA ≥ 2024.6-ish (needs only `auth/sign_path`, `hass-action`, standard card API), frigate-hass-integration ≥ 5.12.0 (`go2rtc/ws` proxy view), Frigate ≥ 0.16 (`live.streams` convention) | MSE path needs none of the HA-native WebRTC machinery. |

## Design

### Config (YAML)

```yaml
type: custom:simpler-camera-card
camera: camera.front_yard        # required — HA camera entity from the Frigate integration
stream: front_yard_sub           # optional — go2rtc stream name; default: entity's camera_name attribute
transport: mse                   # mse (default) | webrtc
overlay: name                    # none (default) | name | custom
overlay_text: "Front Yard"       # used when overlay: custom
tap_action: { action: more-info }        # HA-standard action objects
hold_action: { action: none }
double_tap_action: { action: none }
aspect_ratio: "16:9"             # optional; default: size to the video
reload_after_minutes_down: 0     # 0 (default) = never page-reload
```

`getStubConfig` picks the first `camera.*` entity with a `camera_name` attribute. Sub-stream is pure config: HA exposes no stream selector (verified), and the Frigate camera entity carries exactly `client_id` + `camera_name` attributes — both are read to build the endpoint.

### Module layout (`src/`)

```
index.ts                  — element registration, window.customCards entry
card.ts                   — SimplerCameraCard (Lit): config, hass, render, overlay, poster, actions
types.ts                  — config schema, player/supervisor interfaces, event types  [contract]
endpoint.ts               — endpoint URL construction + auth/sign_path per attempt
player/go2rtc-client.ts   — go2rtc WS protocol client (handshake, MSE binary lane, WebRTC signalling lane)
player/mse-player.ts      — MediaSource/SourceBuffer management, buffer hygiene, jump-to-live
player/webrtc-player.ts   — RTCPeerConnection lane (opt-in transport)
reliability/watchdog.ts   — frame-stall watchdog (rVFC, timeupdate fallback)
reliability/retry.ts      — ExponentialBackoff + RetryTimer (jitter, advance/re-arm)
reliability/supervisor.ts — connection state machine; owns all reconnect triggers and lifecycle events
```

### Supervisor state machine

States: `idle → connecting → playing → retrying(tier1) → remounting(tier2, backoff)`, any state → `idle` on teardown. The supervisor owns the player instance; tier-2 recovery **replaces the whole player** (detector never drives its own recovery — a held not-live verdict prevents flap loops, per ACC rc.4's liveness design). All six reconnect triggers (Key Decisions) feed the same `onDead(reason)` entry point; `reason` is logged to console at `info` for field debugging.

### Verification approach

- Unit (Vitest): backoff/jitter math, retry timer, watchdog arming/gating, go2rtc protocol framing (mock WebSocket), endpoint/signing logic (mock hass).
- Integration (worker-runnable): a local `go2rtc` binary + ffmpeg test-pattern stream exercising the real WS protocol and MSE lane in a headless Chromium (vitest browser mode or playwright) — connect, kill socket, verify auto-recovery, verify stall detection by freezing the source.
- End-to-end (orchestrator-only, singleton): real HA + Frigate via mcp-browser — visual check, tap actions, HA-restart recovery.

## Implementation Plan

1. **[serial] Scaffolding** (M) — package.json, Vite lib-mode build to `dist/simpler-camera-card.js`, tsconfig, Vitest, ESLint/Prettier minimal, `hacs.json`, `make check` (or npm scripts) wiring. Owned files: `package.json`, `vite.config.ts`, `tsconfig.json`, `.eslintrc*`/`prettier*`, `hacs.json`, `src/index.ts` (stub), `Makefile`.
2. **[serial] Contracts + card skeleton** (M) — `src/types.ts` (config schema + player/supervisor interfaces + events, frozen for parallel work), `src/card.ts` skeleton (registers element, `setConfig` validation, renders placeholder + poster area), `src/endpoint.ts`. Owned files: `src/types.ts`, `src/card.ts`, `src/endpoint.ts`, `src/index.ts`.
3. **[parallel-1] go2rtc client + MSE player** (M) — `player/go2rtc-client.ts`, `player/mse-player.ts` + unit tests; implements contract interfaces; includes MSE hygiene rules. Owned files: `src/player/go2rtc-client.ts`, `src/player/mse-player.ts`, `tests/player/*`.
4. **[parallel-1] Reliability layer** (M) — `reliability/watchdog.ts`, `reliability/retry.ts`, `reliability/supervisor.ts` + unit tests against contract interfaces (player mocked). Owned files: `src/reliability/*`, `tests/reliability/*`.
5. **[serial] Integration slice** (M) — wire supervisor + player + endpoint + poster into `card.ts`; local go2rtc integration test (connect/kill/recover). Owned files: `src/card.ts`, `tests/integration/*`.
6. **[serial] Features** (S) — overlay (name/custom), tap/hold/double-tap via `hass-action`, `aspect_ratio`, `reload_after_minutes_down`, `getStubConfig`/`getCardSize`/`getGridOptions`. Owned files: `src/card.ts`, `src/actions.ts` (new).
7. **[serial] WebRTC opt-in transport** (M) — `player/webrtc-player.ts` on the shared signalling client; ICE-state rules; watchdog covers the silent-failure mode. Owned files: `src/player/webrtc-player.ts`, `tests/player/webrtc*`.
8. **[serial] Docs + release polish** (S) — README install/config reference, versioning, `?v=` guidance, vendored-pattern attribution notes. Owned files: `README.md`, `docs/`, `dist/` metadata.

## Open Questions

-

## Deferred / Follow-ups

- Audio playback support (muted-only in v1).
- Visual config editor (`getConfigElement`); v1 ships `getStubConfig` + YAML.
- HACS default-store submission (works as custom repository meanwhile).
- Snapshot-refresh *transport* (ultra-low-power mode cycling `camera_proxy` images).
- Direct-to-Frigate endpoint override (config base URL) for setups without frigate-hass-integration.
- HA-native WebRTC (`camera/webrtc/offer`) as an alternative WebRTC signalling path if `:8555` reachability becomes a problem.
- Safari/iOS polish (ManagedMediaSource, jump-to-live quirks).

## Change Log

- 2026-08-15 — created from research (`docs/idea/research-notes.md`) and first-run decisions.
- 2026-08-15 — approved by James; status draft → approved.
