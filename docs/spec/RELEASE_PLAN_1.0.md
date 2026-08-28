# RELEASE PLAN: v1.0.0 public release

- **Status:** in-progress (structure approved by James 2026-08-28)

## Summary

The card is feature-complete at v0.6.1 (James, 2026-08-28: "its official: we have hit feature-complete"). This plan drives the remaining work: several rounds of review and cleanup until James judges the card perfect — **only then** does the version become 1.0.0 and get released. Not a feature spec; a process checklist worked round by round through the task queue.

## Ground rules (James, 2026-08-28)

- **Public repo:** `https://github.com/bishopdynamics/simpler-camera-card` — git remote `github` (SSH). **The agent only ever pushes to `origin`** (the dev repo at git.bishopdynamics.com); only James pushes to `github`, and doing so *is* the release act. All public-facing documentation references the GitHub URL.
- **Process docs ship as-is:** `docs/`, `CLAUDE.md`, handoff, task queue all remain in the public repo unchanged.
- **No CI.**
- **No HACS default-store submission** — users add the GitHub repo as a HACS custom repository (the old DEFERRED item is dropped, not deferred).
- 1.0.0 version bump happens once, at the very end, on James's explicit word.

## Rounds

Each round ends with findings fixed (or explicitly waived by James) before the next begins.

1. **Deep code review** — full-`src/` correctness review at high effort (reliability layer first: supervisor/loop/timer races, teardown leaks, reconnect edge cases), followed by a security pass (signed URLs and auth paths: what gets logged, cached, exposed in DOM/console/errors).
2. **Simplification & consistency** — dead code, leftover scaffolding, comment/doc-comment accuracy after six versions of drift, naming consistency, test hygiene.
3. **Docs & packaging** — README read end-to-end as a stranger (known: install example still says `?v=0.1.0`); all repo references point at the GitHub URL; attribution audit (ACC rc.4 / go2rtc `video-rtc.js` / Frigate `MsePlayer.tsx` borrowings credited per ROOT_SPEC); LICENSE/`package.json` consistency; hacs.json validated against current HACS custom-repo requirements; CHANGELOG.md created (versions 0.1.0 → present, then maintained).
4. **Fresh-eyes install & UX walkthrough** — from-scratch install following only the README; every config option exercised once against James's real HA.
5. **Release mechanics** — final version sweep, tag `v1.0.0`, James pushes to `github`.

## Status log

- 2026-08-28 — plan created; round 1 started.
- 2026-08-28 — round 1 code review done: 22 candidates → 15 confirmed / 6 plausible / 1 refuted. Nine bugs fixed in v0.6.2 (`c5886fc`): endpoint cache clobber, backoff pinned by HA flapping, MSE disjoint-range hygiene + starvation, snapshot tick deadlock, start-scheduled latch, tap-armable reload hatch, hidden-start streaming, hidden online-resume. 333 tests (25 new regression tests, all written failing-first). **Open:** James to decide on accepting legacy `call-service` + `fire-dom-event` action names. **Round-2 input (verified, below severity cap):** instance-vs-static `getGridOptions`; stale poster write after await; listener re-attach in `updated()` after disconnect; `restart()` prompt refresh swallowed by tick guard; `describeError` ×4 duplication; endpoint resolved at two drift-prone points; watchdog per-frame timer churn; `reload_after_minutes_down` doc gap (live-only); `SNAPSHOT_TICK_TIMEOUT_FLOOR_MS` placement (snapshot.ts vs types.ts); double-tap-on-pointerup (matches HA, likely wontfix); transient config errors saveable via GUI (needs discussion); slider-max-vs-YAML mismatch (James settled 5–60 earlier). Security pass dispatched.
- 2026-08-28 — security review done: **no high-severity findings; verdict "fit for public release."** Three hardening fixes shipped in v0.6.3 (`24ef556`): same-origin enforcement on `auth/sign_path` responses (two layers: `signPath` regex + host assertion in the URL helpers), same-origin filter on the raw `entity_picture` poster fallback (orchestrator tightened the worker's regex to also reject `/\` protocol-relative), WebSocket constructor errors log `error.name` only. 341 tests. **Open decisions for James:** (a) committed `.claude/settings.json` grants blanket `Bash(*)` — move to gitignored settings.local.json before going public? (b) legacy `call-service`/`fire-dom-event` action names. **Slotted:** go2rtc fetch-script checksums → round 2; sourcemap-404 nit → round 3; dist build-attestation noted but James chose no CI. Round 1 complete pending James's sign-off.
- 2026-08-28 — **Round 1 SIGNED OFF.** Decisions: legacy `call-service`/`fire-dom-event` accepted (v0.6.4, `ae8114c`); `.claude/` untracked from git and ignored (files remain on disk). Round 2 started: batch 1 (four card.ts findings) dispatched; batch 2 = cross-cutting cleanup (describeError ×4 extraction, SNAPSHOT_TICK_TIMEOUT_FLOOR_MS → types.ts, reload_after_minutes_down live-only doc gap, snapshot restart-swallowed-refresh, watchdog timer churn, fetch-go2rtc.sh checksums); batch 3 = fresh full-codebase simplification review. Round-2 discussion item for James: transient config errors can be *saved* via the GUI (preview shows red error, config persists invalid) — accept as-is or guard the save?
