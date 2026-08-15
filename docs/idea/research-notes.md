# Initial Research Notes (2026-08-15)

Source-verified research (three parallel agents read go2rtc, Frigate, HA core/frontend, ACC, and AlexxIT/WebRTC source directly) feeding ROOT_SPEC. Environment facts from the user: Chromium-on-Linux/PC wall kiosk, 2–4 camera cards visible per view, browsers have direct LAN access to the Frigate box, HA kept current (native go2rtc/WebRTC available).

## Why Advanced Camera Card never recovers (verified in its source)

ACC vendors go2rtc's `video-rtc.js` with modifications that *break* the upstream recovery paths:

1. **`play()` gutted to a no-op** ("ACC controls playing at a higher level") — but the higher level only reacts to selection/visibility transitions. Every reconnect path calls `play()`; on an always-visible kiosk card, reconnects succeed but the video never resumes. Strongest single explanation of the symptom.
2. **`visibilityCheck = false`** — disables upstream's free teardown/rebuild recovery on visibility changes (AlexxIT's card keeps it on, plus `visibilityThreshold: 0.75` — why other cards recover).
3. **Weakened media-`error` handler** — a no-op in WebRTC mode (the WS is already closed once WebRTC wins the transport race).
4. **Signed URL cached for 24 h, never re-signed** — after an HA restart (signing key rotates), ACC retries the same dead URL every 15 s forever. AlexxIT's card re-signs on *every* reconnect.
5. **No stall watchdog anywhere** — shared gap across ACC, upstream `video-rtc.js`, HA's `ha-web-rtc-player` (whose entire recovery is `restartIce()` on ICE `failed`), and Frigate's HA proxying. A connected-but-frozen stream (WS open / PC "connected", zero frames) is structurally undetectable in all of them.

ACC's maintainer built the right architecture (frame-stall watchdog via `requestVideoFrameCallback`, exponential backoff + jitter, two-tier retry, liveness controller) — it's in the tree at v8.0.0-rc.4, MIT-licensed, **but wired into nothing yet**. Best-in-class reliability model actually shipping: Frigate's own `MsePlayer.tsx` (progress-event-armed stall timeout, adaptive rate control, error-count fallback).

## Transport facts

- go2rtc WS protocol (`/api/ws?src=X`): JSON handshake for `mse` / `webrtc/offer|answer|candidate` / `mjpeg` / `mp4`, then binary frames. Tiny, fully documented in `internal/api/ws/README.md`.
- **Client efficiency**: WebRTC ≥ MSE (both hardware decode; the gap is small) ≫ MJPEG-over-WS / MP4-over-WS (per-frame base64 + poster swaps — avoid). HLS is high-latency and **unsupported in Chrome** without hls.js.
- **Reliability observability**: MSE wins — one WebSocket, bytes and `progress` events both observable, reconnect = new WebSocket. No ICE/NAT/STUN/ports. WebRTC's failure mode (connected-but-dead PC) needs `getStats()`/frame polling to even detect, and go2rtc closes the signalling WS once WebRTC wins.
- **No keepalive anywhere in the chain** (go2rtc sends no pings; the HA websocket proxy sets `autoping=False`) — a blackholed TCP path produces *no* client-side event for minutes. An application-level "no data for N seconds" watchdog is mandatory regardless of transport.
- Codec guidance: H.264 (+AAC) is the compatibility sweet spot; H.265 needs Chrome 136+.

## Access paths to go2rtc (Frigate box, separate machine)

- Port 1984 is **not published** by Frigate's docker setup (nginx proxies it internally). Direct access would need explicit port-forwarding and has no auth.
- **Frigate nginx** (`/live/mse/api/ws`, `/live/webrtc/api/ws` on 8971 authenticated / 5000 unauthenticated) — the comment in Frigate's nginx.conf says "frigate lovelace card uses this path".
- **HA proxy via frigate-hass-integration** (`/api/frigate/{client_id}/go2rtc/ws/api/ws?src=X`, integration ≥5.12.0): same-origin, no CORS/mixed-content, auth via `auth/sign_path` (`?authSig=`). **Preferred default.** Older fallback: `/api/frigate/{id}/mse/api/ws` (deprecated).
- **HA-native WebRTC** (HA 2024.11+, `camera/webrtc/offer` subscription on the existing `hass.connection`): zero extra auth/CORS; media flows browser ↔ HA host port 18555 (HA's bundled go2rtc pulls RTSP from Frigate — an extra hop). With Frigate integration's `enable_webrtc: true` instead, signalling goes to Frigate's go2rtc via one-shot WHEP (needs port 8555 reachable; known bug: uses camera name not stream name).

## Sub-streams

Frigate convention: go2rtc stream `<camera>` (main) and `<camera>_sub` (detect/sub). **No HA-side selector exists** — the stream name must be card config (default: the camera's `camera_name` attribute; the Frigate camera entity exposes exactly `client_id` + `camera_name` attributes). ACC's knob is `go2rtc.stream`.

## Reconnect engineering to adopt (all MIT-borrowable)

- **Frame-stall watchdog**: `requestVideoFrameCallback` re-arms a ~10 s timer; firing ⇒ frozen. Gate on visible + playback-expected (not paused/seeking/hidden — browsers legitimately pause rVFC when backgrounded). ACC rc.4's `FrameStallWatchdog` + `ExponentialBackoff` + `RetryTimer` are self-contained (~330 lines, MIT).
- **Two-tier retry**: ~3 fast in-place retries at ~2 s → escalate to full player remount with jittered exponential backoff (5 s → 600 s cap), forever (kiosk wants infinite retry).
- **ICE states**: `disconnected` is NOT terminal (usually self-heals; the watchdog catches the ones that don't); only `failed` triggers reconnect.
- **Re-sign the WS URL on every reconnect** — never cache authSig.
- **Restart on `hass.connected` false→true edge** (also sidesteps a stale-offer auto-resubscribe bug in HA's own player).
- **Lifecycle**: handle `pagehide`/`freeze`/`resume`/`online` in addition to `visibilitychange` — a frozen tab's pending reconnect timers never fire (matches "freezes once a day on kiosk" field reports).
- **MSE hygiene**: bounds-check the staging buffer (upstream's fixed 2 MB `buf.set()` overflows → permanent stall with a live WS — seen in the wild as `RangeError: source array is too long`); don't swallow `appendBuffer` errors; cap buffered length (>10 s buffered ⇒ broken); jump-to-live instead of `playbackRate` chase on WebKit.
- **Detector ≠ recovery driver**: hold the not-live verdict during remount to avoid unthrottled flap loops.
- **Escape hatch**: optional bounded page-reload after N failed remounts (the only thing the community trusts today).
- `play()` rejection → retry muted (upstream behavior ACC removed).

## Card platform facts

- Custom card: `customElements.define` + `window.customCards.push`; `setConfig`/`hass` property (unchanged contract; a new `hass` object arrives on every state change — gate updates), `getCardSize`/`getGridOptions`, `getConfigElement`/`getStubConfig` or `getConfigForm` for the editor.
- `hui-card` **removes hidden cards from the DOM** unless `connectedWhileHidden = true` — decide deliberately; HA players tear down after 60 s hidden.
- **Actions**: fire the `hass-action` event (HA ≥2023.7) with `{config, action}` — delegates the whole tap/hold/double-tap pipeline (confirmations, more-info, navigate, perform-action) with zero dependencies. Default action when unconfigured is `more-info`. Skip `custom-card-helpers` (lagging vendored snapshot); take types from `home-assistant-js-websocket`.
- Never read `frontend_stream_type` (removed 2025.6); use `camera/capabilities`.
- Distribution: single `dist/` JS via HACS (repo-name-matching file) or `/local/` resource with `?v=` cache-busting.
- Snapshot/poster: signed `/api/camera_proxy/{entity_id}` (or go2rtc `frame.jpeg` via proxy).

## Licenses

go2rtc, ACC, AlexxIT/WebRTC: all MIT. Vendoring pattern: per-directory README naming origin, copyright, license (ACC's own precedent).

## Source clones (session-scratch, transient)

Agents left clones under the session scratchpad (`acc` @ v8.0.0-rc.4, `alexxit-webrtc`, `go2rtc`, HA `frontend src/`, `core/`) — re-clone as needed in future sessions.
