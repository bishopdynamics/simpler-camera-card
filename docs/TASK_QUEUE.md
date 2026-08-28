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

1. FEATURE_SPEC_snapshot_mode.md
   1. Optional `mode: snapshot` — still-image view refreshed every `refresh_interval` seconds (down to ~0.25 FPS) for low-resource kiosks.
   2. Status: spec drafted 2026-08-27 after discussion with James (mechanism = snapshot polling via existing poster resolver; interval in seconds; tap-to-go-live deferred). **Awaiting James's approval of the spec before implementation.**
