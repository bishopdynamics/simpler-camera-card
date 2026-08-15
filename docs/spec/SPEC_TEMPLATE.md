# SPEC: <name>

> Copy this file to `ROOT_SPEC.md` or `FEATURE_SPEC_<thing>.md` and fill it in.
> The purpose of a spec is to answer the important decisions **up front**, so implementation
> can proceed with minimal user input, stopping only when something truly needs their attention.

- **Status:** draft | approved | in-progress | done
- **Addenda:** (ROOT_SPEC only: list of FEATURE_SPEC files that extend this spec)

## Summary

One paragraph: what this is and why it's worth building.

## Goals

- What must be true when this is done.

## Non-Goals

- What is explicitly out of scope (prevents scope creep mid-implementation).

## Key Decisions

The heart of the spec. Every decision recorded here is one the implementation does **not** need to stop and ask about. Include the rationale, and the alternatives considered — if implementation hits a wall, the alternatives are where we return to re-spec.

| Decision | Choice | Rationale / alternatives considered |
| --- | --- | --- |
|  |  |  |

## Design

How it works: architecture, data flow, interfaces, formats. Enough detail that a session with no prior context could implement a slice correctly.

## Implementation Plan

Ordered slices, each independently committable. Tag each with:

- **Autonomy:** (S) small — proceed; (M) medium — proceed if obvious, report choices; (L) large — needs user input.
- **Scheduling:** `[serial]` (the default) or `[parallel-N]` — slices sharing a group number are farmed out to concurrent workers (see "Implementation approach" in `CLAUDE.md`). Slices in the same parallel group must own **disjoint files**, and the shared contracts they build against (interfaces, types, stubs) must land in an earlier serial slice.
- **Owned files:** list them for **every** slice, serial or parallel, at spec-approval time — not lazily during implementation. They sharpen worker briefs, and they are the disjointness proof for parallel groups and for the cross-task parallelism check in `CLAUDE.md`.

> Retrofitting a spec approved before these annotations existed: adding `[serial]`/`[parallel-N]` and owned-files lists is process metadata, not a design change — a docs pass with a change-log line ("scheduling annotations added; no design changes"), no re-approval needed.

1.

## Open Questions

Must be empty before status moves to `approved`. Anything unresolved here is a discussion to have with the user first.

-

## Deferred / Follow-ups

Deliberately not doing now; mirror these into `docs/DEFERRED.md`.

-

## Change Log

- YYYY-MM-DD — created.
