# Attribution

Simpler Camera Card contains **no vendored source code**. Every file under `src/` was written for
this project.

What it does borrow is *design* — protocol usage, constants, and a handful of hard-won rules about
when a stream is really dead. Those came from reading three MIT-licensed projects, and this file says
which idea came from where. All three are MIT, as is this project, so the patterns are freely usable;
this document exists because credit is owed, not because a licence demands a notice for
non-copied work.

## Advanced Camera Card

- Repository: <https://github.com/dermotduffy/advanced-camera-card>
- Version read: v8.0.0-rc.4
- Licence: MIT

The reliability architecture in that tree is right, and at rc.4 much of it was written but not yet
wired to anything. Three things were taken from it:

| Pattern | Where it landed |
| --- | --- |
| Frame-stall watchdog: a `requestVideoFrameCallback` timer re-armed by every presented frame, gated on "playback is expected", with the **held not-live verdict** that keeps a detector from driving its own recovery (and flapping) | `src/reliability/watchdog.ts`, `src/reliability/supervisor.ts` |
| Two-tier retry constants: 3 in-place retries at 2 s, then full remount on exponential backoff (5 s base, ×2, 600 s cap, ×[0.5, 1.0] jitter) | `src/types.ts` (constants), `src/reliability/retry.ts` |
| The ICE-state rule: `disconnected` is **not** terminal — only `failed` triggers a reconnect | `src/player/webrtc-player.ts` |

Nothing was taken from its go2rtc client; the defects that motivated this project live there.

## go2rtc — `video-rtc.js`

- Repository: <https://github.com/AlexxIT/go2rtc> (`www/video-rtc.js`)
- Licence: MIT

The websocket protocol client here is a fresh TypeScript implementation against go2rtc's documented
protocol (`internal/api/ws/README.md`), but three concrete details are upstream's:

| Pattern | Where it landed |
| --- | --- |
| The websocket message flow itself: the `mse` / `webrtc/offer` / `webrtc/answer` / `webrtc/candidate` JSON lane alongside the binary media lane | `src/player/go2rtc-client.ts` |
| The MSE codec candidate list offered in the handshake | `src/player/mse-player.ts` |
| Supplying `sdpMid: '0'` for go2rtc's bare remote ICE candidate strings (go2rtc sends no media identifier, and `addIceCandidate` requires one) | `src/player/webrtc-player.ts` |
| `play()` rejection → mute and retry | `src/player/mse-player.ts`, `src/player/webrtc-player.ts` |

Deliberate divergences from upstream are documented in the module headers of those files — notably the
bounds-checked staging buffer, surfaced (rather than swallowed) `appendBuffer` errors, keeping the
signalling socket open in WebRTC mode, and treating `disconnected` as non-fatal.

## Frigate — `MsePlayer.tsx`

- Repository: <https://github.com/blakeblackshear/frigate> (`web/src/components/player/MsePlayer.tsx`)
- Licence: MIT

Frigate's own player is the best-shipping reference for MSE buffer hygiene, and inspired this card's:

| Pattern | Where it landed |
| --- | --- |
| Buffer hygiene: bound the back-buffer (5 s), treat an over-full buffer as a broken stream (> 10 s ahead of playback), and catch up to the live edge by seeking rather than chasing with `playbackRate` | `src/player/mse-player.ts` |
| The broader principle that a live player must judge health from data actually arriving, not from what the media element's state claims — here realised as a presented-frame watchdog rather than Frigate's `progress`-armed timeout | `src/reliability/watchdog.ts` |

## Also read, nothing borrowed

Home Assistant frontend (`ha-web-rtc-player`) and AlexxIT/WebRTC were read during research; neither
contributed a pattern that survived into this codebase, though AlexxIT/WebRTC's re-sign-on-every-
reconnect behaviour confirmed the endpoint rule in `src/endpoint.ts`.
