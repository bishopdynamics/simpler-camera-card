/**
 * `editor.ts` — the card's visual (GUI) config editor.
 *
 * Home Assistant renders the editor itself: a card that exposes
 * `static getConfigForm()` hands the frontend a **selector schema** and HA
 * builds the whole form out of its own native components (`hui-form-editor` →
 * `ha-form`). There is no custom editor element here, and deliberately so —
 * every option this card has maps onto a stock selector, so a declarative
 * schema costs nothing to maintain and inherits every future HA form
 * improvement for free.
 *
 * Three facts about HA's contract shape everything below (verified against
 * `home-assistant/frontend`: `src/panels/lovelace/types.ts`,
 * `src/components/ha-form/types.ts`, `src/components/ha-form/ha-form.ts`):
 *
 * 1. **`name` is required on every schema node**, groups included. Flatness is
 *    therefore *not* achieved by omitting the name — it comes from
 *    `flatten: true`, which makes `ha-form` read and write the group's children
 *    against the top-level data object instead of `data[groupName]`. Our config
 *    has no nesting, so both group nodes set it.
 * 2. **`assertConfig` is the fidelity guard.** `hui-form-editor.setConfig()`
 *    calls it, and a throw makes HA mark the GUI editor unsupported and drop to
 *    the YAML editor — which is exactly what should happen to a config the form
 *    cannot faithfully round-trip. Better an honest YAML fallback than a
 *    silently mangled dashboard.
 * 3. **`computeLabel` / `computeHelper` are optional overrides.** Without them
 *    HA falls back to its own generic translations and then to a title-cased
 *    field name; we supply English text for every field instead.
 *
 * The validator is injected rather than imported: `card.ts` imports this module
 * for its `getConfigForm()` static, so importing `normalizeConfig` back from
 * `card.ts` here would close an import cycle. {@link buildConfigForm} takes the
 * validator as a parameter, which keeps the dependency one-way and lets tests
 * drive the guard with a stub.
 */

import { OVERLAY_MODES, VIEW_MODES } from './types';

/* -------------------------------------------------------------------------- */
/* Local mirror of HA's form types                                             */
/* -------------------------------------------------------------------------- */

/*
 * As with `HomeAssistant` in `types.ts`, these are a minimal local mirror
 * rather than a dependency on `custom-card-helpers`. Only the node kinds this
 * schema actually uses are modelled; `selector` payloads are left as open
 * records because HA owns that vocabulary and it grows every release.
 */

/** A leaf field: HA picks the widget from the `selector` payload. */
export interface ConfigFormField {
  name: string;
  required?: boolean;
  selector: Record<string, unknown>;
}

/**
 * A collapsible group of fields.
 *
 * `flatten: true` is load-bearing: it is what keeps the emitted config flat
 * (`stream: …`, not `advanced: { stream: … }`).
 */
export interface ConfigFormGroup {
  name: string;
  type: 'expandable';
  title: string;
  flatten: true;
  schema: readonly ConfigFormNode[];
}

export type ConfigFormNode = ConfigFormField | ConfigFormGroup;

/** The object Home Assistant expects back from `getConfigForm()`. */
export interface ConfigForm {
  schema: readonly ConfigFormNode[];
  computeLabel: (schema: { name: string }) => string;
  computeHelper: (schema: { name: string }) => string | undefined;
  assertConfig: (config: unknown) => void;
}

/** Narrow a schema node to a group. Exported so tests can flatten the schema. */
export function isConfigFormGroup(node: ConfigFormNode): node is ConfigFormGroup {
  return 'schema' in node;
}

/* -------------------------------------------------------------------------- */
/* Enum options                                                                */
/* -------------------------------------------------------------------------- */

/*
 * Dropdown options are derived from the frozen constants in `types.ts` at
 * module load, so the editor can never offer a value `normalizeConfig` would
 * reject (or miss one it would accept). Only the human-facing text lives here,
 * with a title-cased fallback so a new enum value still renders sanely.
 */

const ENUM_LABELS: Record<string, string> = {
  none: 'None',
  name: 'Entity name',
  custom: 'Custom text',
  live: 'Live stream (MSE)',
  snapshot: 'Snapshots (low resource)',
};

function optionsFrom(values: readonly string[]): { value: string; label: string }[] {
  return values.map((value) => ({
    value,
    label: ENUM_LABELS[value] ?? value.replace(/_/g, ' '),
  }));
}

const OVERLAY_OPTIONS = optionsFrom(OVERLAY_MODES);
const MODE_OPTIONS = optionsFrom(VIEW_MODES);

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The form layout.
 *
 * The common path is flat and shallow — pick a camera, maybe a label, maybe an
 * aspect ratio — and the two things most configs never touch (the action slots
 * and the escape hatch) are folded into collapsed sections.
 *
 * The schema is deliberately **static**: no field appears or disappears based on
 * another's value. `overlay_text` is always shown, and its helper text carries
 * the "only applies when…" condition instead.
 */
const SCHEMA: readonly ConfigFormNode[] = [
  {
    name: 'camera',
    required: true,
    // The integration filter narrows the picker to exactly the entities this
    // card can stream. If it ever misbehaves in the field, dropping to
    // `{ domain: 'camera' }` is the safe fallback — the card's own errors
    // already explain a non-Frigate pick.
    selector: { entity: { filter: { integration: 'frigate', domain: 'camera' } } },
  },
  { name: 'overlay', selector: { select: { mode: 'dropdown', options: OVERLAY_OPTIONS } } },
  { name: 'overlay_text', selector: { text: {} } },
  { name: 'aspect_ratio', selector: { text: {} } },
  {
    name: 'interactions',
    type: 'expandable',
    title: 'Interactions',
    flatten: true,
    schema: [
      // `ui_action` is HA's own action editor — the same UI the tile and button
      // cards use — and it emits exactly the `ActionConfig` shapes the card
      // already forwards to `hass-action` verbatim.
      { name: 'tap_action', selector: { ui_action: {} } },
      { name: 'hold_action', selector: { ui_action: {} } },
      { name: 'double_tap_action', selector: { ui_action: {} } },
    ],
  },
  {
    name: 'advanced',
    type: 'expandable',
    title: 'Advanced',
    flatten: true,
    schema: [
      { name: 'stream', selector: { text: {} } },
      { name: 'mode', selector: { select: { mode: 'dropdown', options: MODE_OPTIONS } } },
      {
        name: 'refresh_interval',
        selector: { number: { min: 1, step: 0.5, mode: 'box', unit_of_measurement: 's' } },
      },
      {
        name: 'reload_after_minutes_down',
        selector: { number: { min: 0, mode: 'box', unit_of_measurement: 'min' } },
      },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Labels and helper text                                                      */
/* -------------------------------------------------------------------------- */

/*
 * English only. The card has no i18n infrastructure and introducing one for ten
 * labels would cost more than it returns; localization is a follow-up if it is
 * ever asked for.
 */

const LABELS: Record<string, string> = {
  camera: 'Camera',
  stream: 'go2rtc stream name',
  overlay: 'Overlay',
  overlay_text: 'Overlay text',
  tap_action: 'Tap action',
  hold_action: 'Hold action',
  double_tap_action: 'Double tap action',
  aspect_ratio: 'Aspect ratio',
  mode: 'Display mode',
  refresh_interval: 'Snapshot refresh interval',
  reload_after_minutes_down: 'Reload after minutes down',
  interactions: 'Interactions',
  advanced: 'Advanced',
};

const HELPERS: Record<string, string> = {
  camera:
    'The Frigate integration camera entity. It also supplies the snapshot shown while the ' +
    'stream is down, and is the default target for more-info and toggle actions.',
  stream:
    'Defaults to the entity’s camera_name. Set it to play a sub-stream instead, e.g. ' +
    'front_yard_sub.',
  overlay: 'Label drawn across the bottom of the video.',
  overlay_text: 'Only applies when Overlay is set to Custom text, where it is required.',
  aspect_ratio: 'Examples: 16:9, 4:3, or a bare number such as 1.78. The video is letterboxed.',
  tap_action: 'more-info opens Home Assistant’s own live camera dialog.',
  hold_action: 'Fired after pressing and holding for half a second.',
  double_tap_action: 'Fired on two taps within 250 ms.',
  mode:
    'Live stream decodes video continuously. Snapshots poll a still image instead — no ' +
    'WebSocket or video decode, for low-resource kiosks.',
  refresh_interval:
    'Only applies in Snapshots mode: how often a new still is fetched. Minimum 1 second.',
  reload_after_minutes_down:
    'Last resort: reload the whole page after this many consecutive minutes down. ' +
    '0 disables it.',
  interactions: 'What tapping, holding and double-tapping the card do.',
  advanced: 'Sub-stream selection, display mode and the last-resort page reload.',
};

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the object `SimplerCameraCard.getConfigForm()` returns.
 *
 * @param validate the card's `normalizeConfig`. It is called for its throw, not
 *   its return value: HA renders the thrown message (already written for a
 *   human editing YAML) and falls back to the YAML editor. Passing it in rather
 *   than importing it keeps `card.ts → editor.ts` a one-way dependency.
 */
export function buildConfigForm(validate: (config: unknown) => unknown): ConfigForm {
  return {
    schema: SCHEMA,
    computeLabel: (schema) => LABELS[schema.name] ?? schema.name,
    computeHelper: (schema) => HELPERS[schema.name],
    assertConfig: (config) => {
      validate(config);
    },
  };
}
