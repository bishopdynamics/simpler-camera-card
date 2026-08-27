# Task Queue

How to process/manage the Task Queue:

1. Read `CLAUDE.md` and follow its session-start instructions first.
2. Pick the next task from the top of the "Queue" section below.
   1. Most tasks are a feature spec file name, found at `docs/spec/<name>.md`.
3. Explain the task to the user; ask for confirmation or clarification.
4. Implement the task per the "Implementation approach" in `CLAUDE.md` (orchestrator + workers), following the autonomy levels defined there:
   1. Mark the task here with `[in-progress]` when you start.
   2. Stop and ask when a decision genuinely needs the user (big things, spec-impacting changes).
   3. Commit for each slice, update the task's status here, report what was done, and wait for the user before continuing.
5. Sessions will often end partway through implementation — that's expected.
   1. Update the task's state in this document before handing off.
6. Only when a task is complete (the **user's** assessment) is it removed from this document.
7. One task is in-progress at a time by default; order matters.
   1. Parallelism happens *inside* a task — a spec's parallel slice groups.
   2. Exception: a later queue task may run concurrently under the cross-task parallelism rules in `CLAUDE.md` ("Implementation approach") — disjoint owned files, no dependency on in-progress outcomes, and it still gets its own explain-and-confirm (step 3) before dispatch. Mark both tasks `[in-progress]` here.

## Queue

1. ROOT_SPEC.md [in-progress]
   1. Implement the initial specification.
   2. Status: ALL 8 slices done (slice 8: cb36f7e), v0.1.0; v0.1.1 (9935dc5) adds the unavailable-entity attribute-cache fix. `make check` green (269 tests) + integration suite green (3 tests vs real go2rtc). Field evidence: 8 days flawless on James's 24/7 kiosk (2 cameras). Remaining before task completion: orchestrator e2e vs real HA+Frigate (visual, tap actions, HA-restart recovery) — needs James's HA reachable — then James's acceptance. (WebRTC soak dropped: task 3 removes WebRTC. Field evidence since: editor verified by James in his HA; 8+ days flawless MSE on the kiosk.)
2. FEATURE_SPEC_visual_editor.md [in-progress]
   1. Visual (GUI) config editor via HA's `getConfigForm()` selector schema.
   2. Status: approved 2026-08-26; slice 1 (schema + tests) DONE — v0.2.0 shipped; James confirms the editor works in his HA. Remaining: James's formal acceptance (note: transport dropdown is being removed by task 3).
3. FEATURE_SPEC_remove_webrtc.md [in-progress]
   1. Remove the WebRTC transport entirely; MSE-only. Approved by James's direct instruction 2026-08-27 (WebRTC unreachable on his LAN even after go2rtc candidates fix; MSE flawless).
   2. Status: slice 1 (removal) DONE 2026-08-27 — 243 unit + 3 integration tests green, bundle 74.7→66.0 kB, legacy `transport:` keys ignored with regression tests. v0.3.0 shipped. Remaining: James installs 0.3.0, confirms editor (no dropdown) + kiosk streams → acceptance.
