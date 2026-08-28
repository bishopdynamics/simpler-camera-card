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

A pre-built `dist/simpler-camera-card.js` is committed to the repo, so you can also just download it
without building anything.

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

Every option below can be set from the **visual editor** — Home Assistant renders a native form for
the card, with a Frigate-filtered camera picker and HA's standard action editors, so no YAML is
required. The YAML reference is here because it is still the precise description of what each option
does (and because a config the form cannot represent drops back to the YAML editor rather than being
rewritten).

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
| `overlay` | `none` \| `name` \| `custom` | `none` | Label drawn across the bottom of the video. `name` uses the entity's friendly name. |
| `overlay_text` | string | — | Label text. **Required** when `overlay: custom`; ignored otherwise. |
| `tap_action` | action object | `{ action: none }` | Fired as HA's standard `hass-action`. Set `action: more-info` to open Home Assistant's own live camera dialog on tap. |
| `hold_action` | action object | `{ action: none }` | Press and hold for 500 ms. |
| `double_tap_action` | action object | `{ action: none }` | Two taps within 250 ms. |
| `aspect_ratio` | `"W:H"` or number | `16:9` | Accepts `"16:9"`, `"16/9"` or a bare number such as `1.78`. The video is letterboxed inside it (`object-fit: contain`). |
| `reload_after_minutes_down` | number (minutes) | `0` (off) | Escape hatch: reload the whole page after this many consecutive minutes down. |
| `mode` | `live` \| `snapshot` | `live` | `live` decodes the MSE stream continuously; `snapshot` polls a still image instead. See [Snapshot mode](#snapshot-mode). |
| `refresh_interval` | number (seconds) | `5` | How often a new still is fetched. Only meaningful under `mode: snapshot`; minimum `1`, fractional values allowed. |
| `tap_to_live` | boolean | `false` | Only meaningful under `mode: snapshot`. When `true`, tapping the card temporarily switches it to the real live stream instead of firing `tap_action`. See [Tap to go live](#tap-to-go-live). |
| `live_duration` | number (seconds) | `60` | How long the temporary live window from `tap_to_live` stays up before reverting to snapshots. Only meaningful with `tap_to_live: true`. In YAML, minimum `5`, fractional values allowed; the visual editor offers a 5–60 second slider in steps of 5. |

Action objects are Home Assistant's standard ones. `action:` must be one of `more-info`, `toggle`,
`navigate`, `url`, `perform-action`, `assist`, `none` — or the legacy `call-service` and
`fire-dom-event`, accepted for configs copied from other cards; the remaining fields (`navigation_path`,
`url_path`, `perform_action`, `target`, `data`, `confirmation`, …) are handed to HA verbatim, so
anything HA supports works here. `more-info` and `toggle` default to the card's own camera entity.

Keys the card does not recognise are **ignored, not rejected** — Lovelace injects its own
(`view_layout`, `grid_options`, `visibility`, …) and rejecting them would break valid dashboards.
The `transport:` option went the same way in 0.3.0: WebRTC was removed and the card is MSE-only, so a
leftover `transport:` line in an old config is now simply one more ignored key. Nothing to change.

Two gesture details worth knowing, because they are deliberate:

- with the default `double_tap_action: none`, a tap fires the instant your finger lifts (no 250 ms
  wait to see whether a second tap follows);
- with the default `hold_action: none`, a slow press is still a tap, rather than a dead zone.

The card is announced to screen readers as a button (and is keyboard-activatable with Enter/Space)
only when its tap does something: `tap_action` is something other than `none`, or the tap is the
[tap-to-go-live](#tap-to-go-live) toggle. With the default `tap_action: none`, a plain card is not
a button — set `tap_action: { action: more-info }` (or another action) to make it one.

## Sub-streams

Frigate's convention is a second, lower-resolution go2rtc stream named `<camera>_sub`. Home Assistant
exposes no stream selector, so the card takes the stream name straight from config:

```yaml
camera: camera.front_yard      # the HA entity — still used for snapshots and more-info
stream: front_yard_sub         # the go2rtc stream actually played
```

Use it for the cameras in a grid and save the main stream for the full-screen view. Without `stream:`,
the card plays the stream named by the entity's `camera_name` attribute (the main stream).

## Snapshot mode

By default the card decodes the live MSE stream continuously. Set `mode: snapshot` to swap that for a
still image, refreshed every `refresh_interval` seconds (default `5`, minimum `1`, fractional values
allowed) — no WebSocket, no `MediaSource`, no video decode pipeline at all. To set expectations:
this is a slideshow, not low-framerate video. For low-resource kiosks — old tablets, many
cards on one dashboard, a Pi driving the display — that trade is usually a win.

```yaml
type: custom:simpler-camera-card
camera: camera.front_yard
mode: snapshot
refresh_interval: 4
```

Overlay, tap/hold/double-tap actions and `aspect_ratio` all behave exactly as in live mode. A failed
refresh keeps the last good frame on screen and retries on the next tick — the same
never-a-dead-end philosophy as live mode's reconnect logic (see [How recovery works](#how-recovery-works)).

If what you actually want is smooth low-framerate *video* rather than a slideshow, that needs
server-side transcoding, which this card does not do. Define an ffmpeg `fps=`-filtered stream in
go2rtc and select it with the existing `stream:` option — go2rtc does the frame-dropping, not the
card.

### Tap to go live

Set `tap_to_live: true` on a `mode: snapshot` card to make a tap temporarily switch it to the real
live stream, for `live_duration` seconds (default `60`, minimum `5`, fractional values allowed) —
then it reverts back to snapshot polling on its own. Tapping again while live reverts early. While
the temporary live window is playing, a small "LIVE · Ns" countdown pill shows how much longer it
has left, the same way the reconnect status pill appears when the stream is down.

`tap_action` is **not** fired on a card with `tap_to_live: true` — the tap is consumed by the
live/snapshot toggle instead. `hold_action` and `double_tap_action` are unaffected, so bind
`hold_action: { action: more-info }` if you still want a way to reach the more-info dialog. This
option (and `live_duration`) is ignored under `mode: live`, like `refresh_interval`.

```yaml
type: custom:simpler-camera-card
camera: camera.front_yard
mode: snapshot
tap_to_live: true
live_duration: 30
```

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
signing), `src/player/` (go2rtc websocket protocol and the MSE lane), `src/reliability/`
(watchdog, retry, and the supervisor that owns every reconnect decision).

**Releasing.** Two version fields must move together:

- `version` in `package.json`
- `CARD_VERSION` in `src/index.ts` (this is what the console banner prints)

Bump both, rebuild, and **commit the rebuilt `dist/`** (HACS and download installs fetch it straight
from the repo). Every installation must then bump its `?v=` query string to actually pick the new
bundle up.

This repo is driven by a spec/task-queue workflow — see `CLAUDE.md` and `docs/`.

## Licence

MIT — see [LICENSE](LICENSE).

The reliability and streaming design borrows *patterns* (not code) from several MIT-licensed projects;
they are credited in [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).
