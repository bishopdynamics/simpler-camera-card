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
