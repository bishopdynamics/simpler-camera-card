# SPEC: Visual Editor

- **Status:** in-progress

## Summary

Give the card a visual (GUI) config editor in the Lovelace dashboard, so every option can be set without writing YAML. Home Assistant's `getConfigForm()` API (frontend PR #16142, mid-2023; documented on the official custom-card page) lets a card return a **selector schema** that HA renders itself with native form components — no custom editor element, no hacks to force-load `ha-form`. Our config surface maps 1:1 onto stock selectors, so this is a thin, declarative feature.

## Goals

- Every `SimplerCameraCardConfig` option is editable visually: `camera`, `stream`, `transport`, `overlay`, `overlay_text`, `tap_action`, `hold_action`, `double_tap_action`, `aspect_ratio`, `reload_after_minutes_down`.
- Camera selection is a real entity picker, filtered to Frigate camera entities.
- The three action slots use HA's native action editor (`ui_action` selector) — the same UI as the built-in tile/button cards.
- A hand-written YAML config the form cannot faithfully represent never gets silently mangled: `assertConfig` throws, and HA falls back to the YAML editor.
- Editor behavior is covered by unit tests; the real editor is verified end-to-end in James's HA (dovetails with the pending tap-action e2e).

## Non-Goals

- No custom editor element (`getConfigElement`) — that path (with its dynamic-schema powers and its `ha-form` loading hacks) is the documented fallback if `getConfigForm` proves insufficient, not part of this feature.
- No conditional/dynamic form fields (e.g. showing `overlay_text` only when `overlay: custom`) — the schema is static; helper text carries the "only applies when…" information.
- No new config options, and no changes to `normalizeConfig` semantics.
- No preview thumbnail work in the card picker beyond what `window.customCards` already declares.

## Key Decisions

| Decision | Choice | Rationale / alternatives considered |
| --- | --- | --- |
| Editor mechanism | `static getConfigForm()` returning a selector schema | HA renders native form UI itself; ~zero maintenance. Alternative: `getConfigElement()` + own Lit editor — full control and dynamic fields, but needs the load-`ha-form`-via-a-builtin-editor hack and real UI code; revisit only if the form editor hits a wall. |
| Camera field | `entity` selector with `filter: { integration: "frigate", domain: "camera" }` | Restricts the picker to exactly the entities the card can stream. If the integration filter misbehaves in the field, fall back to `domain: camera` only (the card's own errors already explain non-Frigate picks). |
| Action fields | `ui_action` selector, one per slot | Native HA action editor; emits the same `ActionConfig` shapes `validateAction` already accepts and hands through verbatim. |
| `transport` / `overlay` | `select` selector, dropdown mode, options from `TRANSPORTS` / `OVERLAY_MODES` | Values come from the frozen constants in `types.ts`, so the editor can never drift from validation. |
| `aspect_ratio` | `text` selector | The accepted grammar (`"16:9"`, `"16/9"`, bare number) is a string format; a number selector would lose the `W:H` form. Helper text shows examples. |
| `stream`, `overlay_text` | `text` selector | Free-form strings. |
| `reload_after_minutes_down` | `number` selector, `min: 0`, box mode, unit `min` | 0-disables semantics stated in helper text. |
| Form layout | Top-level: camera, transport, overlay, overlay_text, aspect_ratio; expandable **Interactions**: the three actions; expandable **Advanced**: stream, reload_after_minutes_down | Keeps the common path shallow. Expandable sections set `flatten: true` (ha-form requires `name` on every node; the name is inert once flattened) so the emitted config stays flat — the card's config has no nesting. |
| Config fidelity guard | `assertConfig` runs `normalizeConfig` (re-exported from `card.ts`) and throws on failure | One validator, two consumers; the form editor auto-disables into YAML mode on configs the schema can't hold, instead of corrupting them. |
| Labels & helper text | `computeLabel` / `computeHelper` maps over a local table; English only | The card has no i18n infrastructure; introducing one for 10 labels is not worth it. Follow-up if localization is ever requested. |
| Where the code lives | New `src/editor.ts` owning the schema + label tables; `card.ts` gains only the `static getConfigForm()` delegation | Keeps `card.ts` focused; schema is independently unit-testable. |

## Design

- `src/editor.ts` exports `buildConfigForm()` returning `{ schema, computeLabel, computeHelper, assertConfig }`:
  - `schema` is a constant array as decided above. Enum options are derived from `TRANSPORTS` / `OVERLAY_MODES` at module load (map to `{ value, label }` pairs), so a future enum change breaks nothing silently.
  - `assertConfig: (config) => { normalizeConfig(config); }` — exceptions propagate; HA shows the message (already written for humans) and drops to the YAML editor.
  - Label/helper tables are plain `Record<string, string>` keyed by field name; `computeLabel`/`computeHelper` look up `schema.name` with a fallback to the raw name.
- `card.ts`: `static getConfigForm() { return buildConfigForm(); }` — nothing else changes.
- Grouping: "Interactions" and "Advanced" are named `type: "expandable"` schema nodes with `flatten: true`, so nested rendering does not introduce nested config keys. (Verified against `home-assistant/frontend` `ha-form` types/source during slice 1: `name` is required on every node; `flatten` is what keeps reads and writes on the top-level object.)
- Unknown keys Lovelace injects (`view_layout`, `grid_options`, …) are untouched: the form editor only writes keys named in the schema, and `normalizeConfig` already ignores the rest.

## Implementation Plan

1. **Editor schema + wiring + tests** — (M) `[serial]`
   - Owned files: `src/editor.ts` (new), `src/card.ts`, `tests/editor.test.ts` (new), `README.md` (visual-editor note in the config section).
   - Implement `buildConfigForm()` per Design; delegate from `card.ts`; unit-test: every config key appears exactly once in the flattened schema; enum options match `TRANSPORTS`/`OVERLAY_MODES`; `assertConfig` accepts every README example config and rejects a config `normalizeConfig` rejects; labels/helpers exist for every field.
   - Verification: `make check`.
2. **Field verification in real HA** — (M) `[serial]`, orchestrator-only (singleton environment)
   - Owned files: none (verification; doc/handoff updates as needed).
   - Via mcp-browser against James's HA: open card editor, confirm form renders, camera picker filters to Frigate cameras, action editors round-trip, expandables emit flat config, invalid YAML config drops to YAML editor. Bump version + committed `dist/` when accepted.

## Open Questions

- None blocking. (Exact `expandable`/`flatten` schema shape is verified by the worker against HA frontend types during slice 1 — the flat-config outcome is the requirement, the node shape is an implementation detail.)

## Deferred / Follow-ups

- Localized editor labels (`computeLabel` i18n) — only if ever requested.
- Card-picker preview image/thumbnail polish.

## Change Log

- 2026-08-26 — created (draft, pending James's approval).
- 2026-08-26 — approved by James; slice 1 dispatched.
- 2026-08-26 — slice 1 done (Opus worker, orchestrator-verified: 285 tests). Spec correction from field-verified HA source: expandables need `name` + `flatten: true`, not name-less nodes.
