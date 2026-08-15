# Simpler Camera Card

A Home Assistant Lovelace card that shows **one Frigate camera, live, via go2rtc** — and keeps showing it.
It is designed as a simpler alternative to the feature-rich camera cards: no carousels, no menus, no
timeline. One camera, one card, and a reliability layer that treats "the stream is still up" as the
only feature that matters.

Built for wall kiosks and other dashboards that run for weeks without anyone touching them.

## Why

Long-running camera dashboards fail in a handful of ways, and most of them are silent. This card
recovers automatically — with no user interaction, ever — from:

- **network blips** (Wi-Fi drop, switch reboot, brief LAN outage),
- **Home Assistant restarts** — every connection attempt re-signs its URL, so a rotated signing key
  costs one retry instead of permanent death,
- **Frigate / go2rtc restarts**,
- **tab freeze/unfreeze and bfcache restores** — recovery keys off page-lifecycle events, not off
  timers that a frozen tab never runs,
- **HA websocket reconnects**,
- **frozen-but-connected streams** — the socket is open, the player says "playing", and no new frame
  has arrived for ten seconds. Nothing else in the ecosystem detects this; it is the reason this card
  exists.

There is no terminal failure state. The card retries forever, because a kiosk has nobody to press
reload.

## Requirements

| | |
| --- | --- |
| Home Assistant | ≥ 2024.6 (needs only `auth/sign_path`, `hass-action`, the standard card API) |
| [frigate-hass-integration](https://github.com/blakeblackshear/frigate-hass-integration) | ≥ 5.12.0 — provides the `go2rtc/ws` proxy view and the `client_id` / `camera_name` entity attributes |
| [Frigate](https://frigate.video/) | ≥ 0.16, with the camera exposed through go2rtc (`live.streams`) |
| Browser | Chromium-based is the primary target. Safari/iOS is not a v1 acceptance criterion. |

Cameras that are not reachable through go2rtc are out of scope — there is no HLS, jsmpeg or
generic-camera fallback. Video is **muted**; audio is a follow-up.

Everything the card fetches goes through Home Assistant's own origin (`/api/frigate/...`,
`/api/camera_proxy/...`) in MSE mode, so there is no CORS, no mixed content and no extra port to open.

## Install

### Build the bundle

```sh
make setup     # npm install
make build     # -> dist/simpler-camera-card.js
```

`dist/` is not committed, so building (or taking the file from a release artifact) is the way to get
the bundle.

### Add it to Home Assistant

1. Copy `dist/simpler-camera-card.js` to `/config/www/` on your HA host.
2. **Settings → Dashboards → ⋮ → Resources → Add resource**:
   - URL: `/local/simpler-camera-card.js?v=0.1.0`
   - Type: *JavaScript module*
3. Reload the dashboard.

**About `?v=`** — bump that number on *every* update. Kiosk browsers cache `/local/` files hard, and a
stale bundle looks exactly like a broken card. The version the browser actually loaded is printed to
the console at startup (`SIMPLER-CAMERA-CARD v0.1.0`); if that does not match what you installed, the
cache is the problem, not the card.

### HACS

The repo is HACS-shaped (`hacs.json` + a single `dist/` bundle), but it is **not in the HACS default
store**. Where HACS can reach the repository over the network, adding it as a *custom repository* of
category *Dashboard* works; otherwise use the manual `/local/` install above.

## Configuration

Minimal — everything else has a default:

```yaml
type: custom:simpler-camera-card
camera: camera.front_yard
```

A fuller example:

```yaml
type: custom:simpler-camera-card
camera: camera.front_yard
stream: front_yard_sub            # go2rtc sub-stream
transport: webrtc                 # lower latency; needs LAN access to Frigate :8555
overlay: custom
overlay_text: Front Yard
hold_action:
  action: navigate
  navigation_path: /lovelace/cameras
aspect_ratio: "16:9"
reload_after_minutes_down: 30     # last-resort page reload
```

### Options

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `camera` | entity id | *(required)* | The Frigate integration's HA camera entity, e.g. `camera.front_yard`. Must be in the `camera.` domain. |
| `stream` | string | the entity's `camera_name` attribute | go2rtc stream name. This is how you select a sub-stream — see below. |
| `transport` | `mse` \| `webrtc` | `mse` | Streaming transport. See [WebRTC mode](#webrtc-mode). |
| `overlay` | `none` \| `name` \| `custom` | `none` | Label drawn across the bottom of the video. `name` uses the entity's friendly name. |
| `overlay_text` | string | — | Label text. **Required** when `overlay: custom`; ignored otherwise. |
| `tap_action` | action object | `{ action: more-info }` | Fired as HA's standard `hass-action`, so `more-info` opens Home Assistant's own live camera dialog. |
| `hold_action` | action object | `{ action: none }` | Press and hold for 500 ms. |
| `double_tap_action` | action object | `{ action: none }` | Two taps within 250 ms. |
| `aspect_ratio` | `"W:H"` or number | `16:9` | Accepts `"16:9"`, `"16/9"` or a bare number such as `1.78`. The video is letterboxed inside it (`object-fit: contain`). |
| `reload_after_minutes_down` | number (minutes) | `0` (off) | Escape hatch: reload the whole page after this many consecutive minutes down. |

Action objects are Home Assistant's standard ones. `action:` must be one of `more-info`, `toggle`,
`navigate`, `url`, `perform-action`, `assist`, `none`; the remaining fields (`navigation_path`,
`url_path`, `perform_action`, `target`, `data`, `confirmation`, …) are handed to HA verbatim, so
anything HA supports works here. `more-info` and `toggle` default to the card's own camera entity.

Keys the card does not recognise are **ignored, not rejected** — Lovelace injects its own
(`view_layout`, `grid_options`, `visibility`, …) and rejecting them would break valid dashboards.

Two gesture details worth knowing, because they are deliberate:

- with the default `double_tap_action: none`, a tap fires the instant your finger lifts (no 250 ms
  wait to see whether a second tap follows);
- with the default `hold_action: none`, a slow press is still a tap, rather than a dead zone.

The card is announced to screen readers as a button (and is keyboard-activatable with Enter/Space)
only when `tap_action` is something other than `none`.

## Sub-streams

Frigate's convention is a second, lower-resolution go2rtc stream named `<camera>_sub`. Home Assistant
exposes no stream selector, so the card takes the stream name straight from config:

```yaml
camera: camera.front_yard      # the HA entity — still used for snapshots and more-info
stream: front_yard_sub         # the go2rtc stream actually played
```

Use it for the cameras in a grid and save the main stream for the full-screen view. Without `stream:`,
the card plays the stream named by the entity's `camera_name` attribute (the main stream).

## WebRTC mode

`transport: webrtc` signals over the *same* go2rtc websocket as MSE, but the media then flows directly
from your browser to Frigate.

- **What it buys:** lower latency than MSE.
- **What it needs:** the browser must be able to reach Frigate's WebRTC port, **`:8555`** (UDP and TCP),
  directly. The card offers **no ICE servers** — no STUN, no TURN, none configurable in v1 — because it
  assumes browser and Frigate share a LAN.
- **Recommendation:** stay on the default `mse` unless you specifically need the latency. MSE is one
  websocket through HA's own origin, hardware-decoded, with no NAT to negotiate — it is what Frigate's
  own UI uses, and it is far easier to debug.

## How recovery works

You do not have to configure any of this; it is what the card does.

1. **Watchdog.** Every frame the browser actually presents re-arms a 10-second timer. If the timer
   fires while playback is expected (tab visible, not paused), the stream is declared dead — no matter
   what the socket or the peer connection claim. This is what catches the frozen-but-connected case.
2. **Tier 1 — fast retry.** Up to 3 in-place retries, 2 seconds apart.
3. **Tier 2 — remount.** The entire player is thrown away and rebuilt, on exponential backoff: 5 s,
   doubling, capped at 10 minutes, each delay randomly shortened by up to half so that several cards
   do not all reconnect in lockstep. This repeats **forever**.
4. **While it is down**, the card shows the camera's latest snapshot, dimmed, with a small status pill
   in the corner ("Reconnecting in 8 s…"). The snapshot is re-signed and refreshed every 10 seconds, so
   a blip degrades to a slightly stale picture rather than a black rectangle.
5. **Hidden tabs** tear the stream down after a 5-second grace period and reconnect when the tab is
   visible again.
6. **`reload_after_minutes_down`** is the last resort: if the stream has been continuously down for
   that many minutes, the card reloads the page. Off by default, and never needed in normal operation —
   it exists for the failure nobody has characterised yet.

## Troubleshooting

Every log line the card writes is prefixed `[simpler-camera-card]`, at `info` level, in the browser
console — including *why* each reconnect was triggered. That is the first place to look.

| Symptom | Cause / fix |
| --- | --- |
| `... has no "client_id" attribute, so it is not a Frigate camera` | The entity is not from frigate-hass-integration (or it predates 5.12.0). Only Frigate integration cameras work; check you picked the right entity. |
| `... has no "camera_name" attribute` | Same family of problem. Set `stream:` explicitly to name the go2rtc stream. |
| `Entity camera.x not found` | Typo in `camera:`, or the Frigate integration has not loaded yet. |
| `Home Assistant refused to sign ...` | HA rejected `auth/sign_path`. Usually a transient websocket problem; the card keeps retrying. |
| Status pill stuck on `Connecting…` / `Reconnecting…` | go2rtc has no such stream, or cannot pull from the camera. Check the stream name against Frigate's go2rtc config, and Frigate's own logs. |
| `transport: webrtc` never connects but `mse` works | The browser cannot reach Frigate's `:8555`. Fix the network path or go back to `mse`. |
| Card looks stale after an update | The `?v=` in the dashboard resource URL was not bumped. Compare the version banner in the console against what you installed. |
| No audio | By design — v1 plays muted video only. |

## Development

```sh
make setup            # npm install
make check            # lint + typecheck + unit tests + build   <- the gate
make build            # dist/simpler-camera-card.js
make test-integration # real go2rtc + ffmpeg + headless Chromium; skips cleanly if absent
```

The stack is TypeScript + [Lit](https://lit.dev/), bundled by Vite into a single ES module (Lit is
bundled in — the card has no runtime dependency to resolve on the HA frontend). Tests are Vitest on
happy-dom.

Layout: `src/card.ts` (config, render, poster), `src/endpoint.ts` (URL construction + per-attempt
signing), `src/player/` (go2rtc websocket protocol, MSE and WebRTC lanes), `src/reliability/`
(watchdog, retry, and the supervisor that owns every reconnect decision).

**Releasing.** Two version fields must move together:

- `version` in `package.json`
- `CARD_VERSION` in `src/index.ts` (this is what the console banner prints)

Bump both, rebuild, and remember that every installation must bump its `?v=` query string to actually
pick the new bundle up.

This repo is driven by a spec/task-queue workflow — see `CLAUDE.md` and `docs/`.

## Licence

MIT — see [LICENSE](LICENSE).

The reliability and streaming design borrows *patterns* (not code) from several MIT-licensed projects;
they are credited in [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).
