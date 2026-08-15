# Project: (name not set — see First Run)

(one-line project description — set during first run)

> **First run:** if `docs/FIRST_RUN.md` exists, this project has not been initialized yet.
> Complete that process before doing anything else.

## Session start (every session)

1. Investigate the available skills and tools — particularly `elefant` and `dev-tools` — so you know what is at your disposal.
2. Consult Elefant (your auxiliary memory system) **before taking any action**. Search using this project's folder name as a keyword/tag; most useful context lives in memories, not the wiki.
3. If `Elefant-Offline.md` exists at the repo root, it is the local cache of memories written while Elefant was offline. Add its entries to Elefant, removing each from the cache once successfully added. If the file doesn't exist, Elefant simply hasn't been offline recently.
4. Read `docs/handoff/evergreen.md` (always-relevant handoff info), then `docs/handoff/index.md` (the previous session's handoff).
5. Read `docs/TASK_QUEUE.md` and process it according to its rules.

## Document system

- `docs/idea/initial-idea.md` — user-authored: the raw project idea. Input to the first planning task, which produces `docs/spec/ROOT_SPEC.md`.
- `docs/TODO.md` — **user-managed** intake list for the user's ideas. The only change the agent makes there is marking items done.
- `docs/DEFERRED.md` — **agent-maintained** list of things deliberately deferred, mirrored from each spec's Deferred / Follow-ups section. Never write deferred items into `docs/TODO.md`; the user promotes items from here when the time is right.
- `docs/spec/` — feature specs. `ROOT_SPEC.md` covers the first sprint; every later feature gets `FEATURE_SPEC_<thing>.md` and is referenced as an addendum at the top of `ROOT_SPEC.md`. Use `docs/spec/SPEC_TEMPLATE.md` as the skeleton.
- `docs/TASK_QUEUE.md` — **agent-worked** ordered queue that drives session-by-session work; entries mostly point at spec files.
- `docs/handoff/` — cross-session continuity, auxiliary to Elefant (whose read path may be unreliable). `index.md` holds the live current block; older entries move to `archive_<number>.md`; durable always-read info lives in `evergreen.md`.

Lifecycle: idea → research & discuss → spec → task queue → implement in slices → done (the user's assessment, not yours).

## Autonomy levels

The goal is to answer the important decisions **in the spec**, so implementation proceeds with minimal input.

- **Small things:** handle automatically, with the spec as the guide.
- **Medium things:** handle automatically when "the right way" is obvious — but report every such choice at the end.
- **Big things:** stop and get the user's input. Especially anything that impacts the spec (e.g. "cannot implement it the way we thought; need to go back to alternative approaches and re-spec").
- **Context limit:** when context usage grows beyond ~60%, stop at the next clean point — update handoff and memories, then hand off.

## Implementation approach (orchestrator + workers)

When implementing a spec, the session acts as an **orchestrator**: it farms slices out to subagent workers (Agent tool), then verifies and reviews their work. The orchestrator writes briefs, dispatches, merges, verifies, and reviews — it implements only trivial glue itself. This also keeps its context lean.

- **Scheduling comes from the spec.** Each slice in the Implementation Plan is marked `[serial]` or `[parallel-N]`; slices sharing a parallel group number are dispatched concurrently.
- **Cross-task parallelism (exception).** Parallelism normally happens inside a task, but the orchestrator may dispatch a *later queue task* concurrently with the in-progress one when **all** of: (a) the two specs' owned-files lists are provably disjoint; (b) the later spec is approved and does not depend on outcomes of any in-progress task (decisions, behavior, or formats still being settled — this is a judgment call, not just a file check); (c) the later task still goes through the queue's normal explain-and-confirm step before dispatch. Shared continuity docs (dev guide, handoff, `DEFERRED.md`) never count as disjoint — the orchestrator serializes those edits itself.
- **Contracts first.** Shared interfaces/types/stubs land in a serial slice *before* any parallel group; parallel workers implement against that frozen contract and own disjoint files. A change to a protocol with two ends in different languages/components (e.g. a wire format with a serializer in one language and a parser in another) is itself a single contract: both ends belong to **one** worker — never split the ends of one protocol across parallel workers, or they drift against a prose description and are only testable together.
- **Every worker gets a brief** built from `docs/spec/TASK_BRIEF_TEMPLATE.md`. Workers share no context with the orchestrator — the brief must be self-contained.
- **Non-code duties are orchestrator-only.** Handoff docs, memory-system writes (Elefant), `DEFERRED.md` mirroring, and task-queue bookkeeping never appear in a worker's brief — workers lack the context to write accurate continuity, and concurrent appends corrupt exactly the files that must stay coherent.
- **Models:** always pass `model` explicitly in every Agent call — an omitted parameter inherits the *session's* model, making worker cost and capability nondeterministic. Default `model: "opus"`; downgrade mechanical slices (boilerplate, scaffolding, rote refactors) to Sonnet — that's a medium thing: report every downgrade.
- **Isolation:** parallel workers run with `isolation: "worktree"`, each committing on its own branch; the orchestrator merges in dependency order. A lone serial worker may work in the main tree. Worktree isolation has a real per-worker cost in compiled/toolchain-heavy projects (cold build, per-checkout artifacts) — weigh that tax against the parallelism win when deciding serial vs parallel; small groups often lose. A shared build cache (e.g. `CARGO_TARGET_DIR`) is a mitigation with a cost: build-dir locking largely serializes concurrent builds, trading cold-build time against parallelism.
- **Verify, then review.** A worker's claim of success is not evidence. Workers must include real verification output in their report; the orchestrator re-runs verification itself after each merge, then reviews the diff. Briefs carry only the worker-runnable subset of verification (unit tests, linters, `make check`); anything bound to a singleton environment (GUI/end-to-end, device-attached tests, staging deploys, session-scoped debug adapters) cannot fan out to N worktrees and is run by the orchestrator post-merge.
- **Off-course workers:** course-correct via SendMessage. If a worker breaks its brief (touched unowned files, can't pass verification), discard its branch and re-dispatch with a better brief — don't hand-patch structural failures.

## Session end

- Update `docs/handoff/index.md` with the session's handoff. Keep it minimal: split older entries into `docs/handoff/archive_<number>.md` and promote durable reference info into `docs/handoff/evergreen.md`.
- Create Elefant memories as you go, so no progress information is lost between sessions. If Elefant is offline, append them to `Elefant-Offline.md` at the repo root instead.

## Environment rules

- `rm` may never be run with `-f`/`--force`; any command containing it is denied in full. This is policy, not a transient error — simply rerun the same command without the `f` flag (`rm` and `rm -r` work fine). A hook will remind you if you forget.
- The team develops on both macOS and Linux (Debian-family, mostly Linux Mint). Keep scripts and tooling portable across both.
