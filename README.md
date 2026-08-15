# Simpler Camera Card

A simpler, more robust Home Assistant camera card for Frigate — single-camera live view via go2rtc that survives network blips on long-running dashboards.

## Why

[Advanced Camera Card](https://github.com/dermotduffy/advanced-camera-card) has grown too advanced: on a long-running dashboard (e.g. a wall kiosk) a stream will eventually "blip" and never recover. This card is a fresh, minimal replacement focused on doing one thing reliably.

**In scope:** live view of a single camera, a couple of stream-transport options (most efficient as default), configurable tap action (default: more-info view), sub-stream selection, name/text overlay.

**Deliberately out of scope:** multi-camera layouts, casting/AirPlay, PTZ controls, timeline, menus/status bars.

## Stack

- TypeScript + [Lit](https://lit.dev/) (the same stack as the Home Assistant frontend), bundled to a single `dist/` JS file installed as a Lovelace resource.
- Streams come from [Frigate](https://frigate.video/) via [go2rtc](https://github.com/AlexxIT/go2rtc).

## Build / run

Not set up yet — scaffolding lands with the first implementation task. See `docs/TASK_QUEUE.md`.

## Development process

This repo is driven by a spec/task-queue workflow — see `CLAUDE.md` and `docs/`.
