# Evergreen Handoff

Durable handoff info — the kind of stuff that should be read at the start of every session, regardless of what the last session did. Keep entries current; delete them when they stop being true.

## Evergreen Entries

- **Kind of project:** Home Assistant Lovelace custom card (browser-side custom element, installed as a single JS resource file). Cameras are Frigate feeds; live streaming via go2rtc.
- **Approach decision (2026-08-15):** build fresh, do **not** fork Advanced Camera Card. ACC's complexity is the source of its unreliability; we borrow its streaming ideas/glue selectively where useful and own the reconnect logic outright.
- **Language & toolchain:** TypeScript + Lit (matches the HA frontend), bundled to one `dist/` JS file (bundler — Vite or Rollup — finalized in ROOT_SPEC). Build scaffolding deliberately deferred to the first implementation task so planning can settle the exact setup.
- **Repository structure:** `src/` (card source) → `dist/` (built artifact, gitignored), `docs/` (process docs per CLAUDE.md). Test layout decided with the toolchain in ROOT_SPEC.
- **Reliability is the core requirement:** streams must recover automatically from network blips on long-running wall-kiosk dashboards. Every streaming decision gets judged against this first.
