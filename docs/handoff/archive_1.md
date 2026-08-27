# Handoff Archive 1

Older handoff entries, split from `index.md`. Newest at top.

- 2026-08-15 — **ROOT_SPEC implementation: all 8 slices done, v0.1.0** (HEAD `cb36f7e`). Orchestrator+workers per CLAUDE.md; every slice verified (`make check`, 264 unit tests) and the integration suite runs against a real go2rtc (`make test-integration`; needs `scripts/fetch-go2rtc.sh` + ffmpeg + system Chrome — Playwright's bundled Chromium lacks H.264).
  - **Remaining before task completion:** orchestrator-only e2e vs James's real HA + Frigate via mcp-browser — visual check, tap actions, HA-restart recovery, and a WebRTC soak >2 min *through the HA proxy* (slice-7 field risk: an idle signalling WS being closed would cause periodic remounts; go2rtc itself verified clean for 2.5 min idle; the HA frigate-integration proxy is the untested half). Then James's acceptance removes the task from the queue. *(2026-08-27 note: the WebRTC soak became moot — WebRTC was removed entirely.)*
  - Key field gotchas discovered: go2rtc 403s cross-origin WS upgrades (integration rig sets `api.origin: "*"`; production is same-origin via HA proxy); machine has `NODE_ENV=production` in shell (`.npmrc include=dev` fixes installs — keep it); TS pinned 6.0.3 until typescript-eslint supports TS 7.
  - Deferred additions this session: release-artifact publishing (dist/ is gitignored; HACS/manual-download path needs a built artifact) — see `docs/DEFERRED.md`.
  - Full slice-by-slice detail lives in Elefant (tag `simpler-camera-card`).
