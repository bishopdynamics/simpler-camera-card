# Handoff Main Index

This is where a new session looks for handoff information from previous sessions. Keep this file minimal: it holds the live current-session block; when it grows too large, split older entries into `archive_<number>.md` next to this file and reference them below. Durable always-read info belongs in `evergreen.md` instead.

## Current

- 2026-08-27 (later session) — **ROOT_SPEC accepted & closed; snapshot mode shipped in v0.4.0 and ACCEPTED** ("snapshot mode works really well" — field-verified; spec done, queue empty). Follow-up: James asked about sub-second intervals (0.5/0.25 s); after discussion he chose to keep the 1 s floor as-is — settled decision, not deferred (rationale: sub-second JPEG polling inverts the mode's resource advantage; go2rtc `fps=` transcode via `stream:` is the answer at 2–4 FPS).
  - James confirmed tap actions + HA-restart recovery in his HA → ROOT_SPEC done and removed from the queue (`e500f72`). First sprint fully complete.
  - New feature, same session: **FEATURE_SPEC_snapshot_mode** — `mode: live|snapshot` + `refresh_interval` (seconds, ≥1, default 5). Discussed → spec'd → approved → implemented in 3 serial slices (`587119d`, `e42a31b`, `e15c04d`). Mechanism: polls the signed poster URL (`resolvePosterUrl`) into a preloaded `<img>`; new `src/snapshot.ts` (`SnapshotLoop` — generation-stamped ticks, overlap guard, pause on hidden, stale pill after 3 consecutive failures); no supervisor/WS/decoder constructed in snapshot mode; live path untouched. Editor fields live in the "Advanced" group. 280 unit tests green.
  - **Queue now:** FEATURE_SPEC_snapshot_mode [in-progress] — implementation done; awaiting James trying v0.4.0 in the field, then acceptance.
  - Deferred added: tap-to-go-live (see `docs/DEFERRED.md`); the old "Snapshot-refresh transport" deferred item was promoted into this spec and removed.

- 2026-08-27 — **v0.3.0: card is MSE-only; visual editor shipped and accepted; two field fixes** (HEAD `ca700fd` + this session-end docs commit).
  - **Shipped & accepted by James this session pair (08-26/27):**
    - v0.1.1 (`9935dc5`): unavailable-entity fix — endpoint resolution caches last-known-good `client_id`/`camera_name` per entity and falls back when HA strips attributes (camera outage at the Frigate end), killing the false "not a Frigate camera" retry loop.
    - v0.2.0 (`49f3c24`): visual editor via `getConfigForm()` selector schema (`src/editor.ts`) — FEATURE_SPEC_visual_editor **done**. Key API fact: ha-form requires `name` on every node; flat config emission comes from `flatten: true` on expandable groups.
    - v0.3.0 (`ca700fd`): **WebRTC removed entirely** — FEATURE_SPEC_remove_webrtc **done**. WebRTC never connected on James's LAN (direct :8555 too fragile even with go2rtc `candidates`); MSE declared the sole mode. Legacy `transport:` YAML keys silently ignored (regression-tested). 243 unit + 3 integration tests green.
  - **Queue now:** only ROOT_SPEC remains [in-progress]. Its last step: orchestrator e2e vs James's real HA (tap actions — still untested by James — and HA-restart recovery; the visual check is effectively field-proven), then acceptance. Needs James's HA reachable via mcp-browser; ask for URL + login when he's ready.
  - **Field evidence:** 8+ days flawless MSE streaming, 2 cameras, 24/7 kiosk; editor field-verified by James at 0.2.0 and 0.3.0.
  - Gotcha added this session: vitest's happy-dom environment blocks `node:fs` imports — `tests/editor.test.ts` reads README via `process.getBuiltinModule('fs')`; `engines: node >=20.16` added to package.json for it.

## Archives

- `archive_1.md` — 2026-08-15: ROOT_SPEC implementation detail (all 8 slices, v0.1.0, integration-rig gotchas).
