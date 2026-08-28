import { describe, expect, it } from 'vitest';
import { SimplerCameraCard, normalizeConfig } from '../src/card';
import {
  buildConfigForm,
  isConfigFormGroup,
  type ConfigForm,
  type ConfigFormField,
  type ConfigFormNode,
} from '../src/editor';
import { CARD_TYPE, OVERLAY_MODES, VIEW_MODES, type SimplerCameraCardConfig } from '../src/types';

const form: ConfigForm = buildConfigForm(normalizeConfig);

/** Depth-first walk over the schema, yielding only the leaf (selector) fields. */
function fields(schema: readonly ConfigFormNode[]): ConfigFormField[] {
  return schema.flatMap((node) => (isConfigFormGroup(node) ? fields(node.schema) : [node]));
}

const leaves = fields(form.schema);
const leafNames = leaves.map((field) => field.name);

function field(name: string): ConfigFormField {
  const found = leaves.find((leaf) => leaf.name === name);
  if (!found) throw new Error(`no schema field named "${name}"`);
  return found;
}

/**
 * Every configurable key, spelled out as a real config object so TypeScript's
 * excess-property checking catches a typo here. The `type` key is excluded: it
 * is the card identity, not a user setting, and Lovelace owns it.
 */
const EVERY_OPTION: SimplerCameraCardConfig = {
  type: CARD_TYPE,
  camera: 'camera.front_yard',
  stream: 'front_yard_sub',
  overlay: 'custom',
  overlay_text: 'Front Yard',
  tap_action: { action: 'more-info' },
  hold_action: { action: 'none' },
  double_tap_action: { action: 'none' },
  aspect_ratio: '16:9',
  reload_after_minutes_down: 30,
  mode: 'snapshot',
  refresh_interval: 4,
  tap_to_live: true,
  live_duration: 30,
};

const CONFIG_KEYS = Object.keys(EVERY_OPTION).filter((key) => key !== 'type');

/* -------------------------------------------------------------------------- */
/* README                                                                      */
/* -------------------------------------------------------------------------- */

/*
 * The suite runs under the `happy-dom` environment, where Vite externalizes
 * `node:fs` for "browser compatibility" and the import blows up at load time.
 * `process.getBuiltinModule` reaches the real module without an import
 * statement for Vite to rewrite — the tests still run in Node, only the DOM is
 * simulated. Vitest's cwd is the project root (`vite.config.ts`'s directory),
 * which `import.meta.url` is not a usable substitute for here — Vite rewrites
 * it to a non-`file:` URL.
 */
const readme = process.getBuiltinModule('fs').readFileSync(`${process.cwd()}/README.md`, 'utf8');

/** Drop a trailing `# comment`, respecting quoted values. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function coerce(raw: string): unknown {
  const value = raw.trim();
  if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/**
 * Parse the flat, one-level-of-nesting YAML the README's config examples use.
 * A real YAML parser would be a production dependency for a documentation
 * test; this understands exactly the subset the examples are written in and
 * fails loudly on anything else.
 */
function parseExample(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let nested = root;

  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) continue;
    const isNested = /^\s+\S/.test(rawLine);
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    const colon = line.indexOf(':');
    if (colon === -1) throw new Error(`unsupported YAML line in README: ${rawLine}`);
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();

    if (isNested) {
      nested[key] = coerce(rest);
    } else if (rest === '') {
      const child: Record<string, unknown> = {};
      root[key] = child;
      nested = child;
    } else {
      root[key] = coerce(rest);
      nested = root;
    }
  }
  return root;
}

/** Every fenced ```yaml block in the README that is (or extends) a card config. */
const readmeExamples = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)]
  .map((match) => match[1])
  .filter((block) => /^camera:/m.test(block))
  .map(parseExample);

/** The keys documented in the README's "### Options" table. */
const documentedKeys = [...readme.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('config form schema', () => {
  it('covers every config option exactly once', () => {
    expect([...leafNames].sort()).toEqual([...CONFIG_KEYS].sort());
    expect(new Set(leafNames).size).toBe(leafNames.length);
  });

  it('matches the options documented in the README', () => {
    expect([...documentedKeys].sort()).toEqual([...CONFIG_KEYS].sort());
  });

  it('keeps the emitted config flat', () => {
    const groups = form.schema.filter(isConfigFormGroup);
    expect(groups.map((group) => group.name)).toEqual(['interactions', 'advanced']);
    // `name` is mandatory on every ha-form node, so flatness comes from
    // `flatten: true` — without it HA would write `advanced: { stream: … }`.
    for (const group of groups) {
      expect(group.type).toBe('expandable');
      expect(group.flatten).toBe(true);
      expect(group.title).toBeTruthy();
    }
  });

  it('puts the common options at the top level', () => {
    const topLevel = form.schema.filter((node) => !isConfigFormGroup(node)).map((n) => n.name);
    expect(topLevel).toEqual([
      'camera',
      'mode',
      'tap_to_live',
      'live_duration',
      'overlay',
      'overlay_text',
    ]);
  });

  it('picks the camera with a Frigate-filtered entity selector', () => {
    expect(field('camera').required).toBe(true);
    expect(field('camera').selector).toEqual({
      entity: { filter: { integration: 'frigate', domain: 'camera' } },
    });
  });

  it('offers exactly the overlay modes validation accepts', () => {
    const options = (name: string): { value: string; label: string }[] =>
      (field(name).selector.select as { options: { value: string; label: string }[] }).options;

    expect(options('overlay').map((o) => o.value)).toEqual([...OVERLAY_MODES]);
    expect((field('overlay').selector.select as { mode: string }).mode).toBe('dropdown');
    for (const option of options('overlay')) expect(option.label).not.toBe('');
  });

  it('uses HA’s own action editor for all three gesture slots', () => {
    for (const name of ['tap_action', 'hold_action', 'double_tap_action']) {
      expect(field(name).selector).toEqual({ ui_action: {} });
    }
  });

  it('uses text and number selectors for the remaining options', () => {
    expect(field('stream').selector).toEqual({ text: {} });
    expect(field('overlay_text').selector).toEqual({ text: {} });
    expect(field('aspect_ratio').selector).toEqual({ text: {} });
    expect(field('reload_after_minutes_down').selector).toEqual({
      number: { min: 0, mode: 'box', unit_of_measurement: 'min' },
    });
  });

  it('offers exactly the display modes validation accepts', () => {
    const options = (
      field('mode').selector.select as { options: { value: string; label: string }[] }
    ).options;
    expect(options.map((o) => o.value)).toEqual([...VIEW_MODES]);
    expect((field('mode').selector.select as { mode: string }).mode).toBe('dropdown');
    for (const option of options) expect(option.label).not.toBe('');
  });

  it('requires a snapshot refresh interval of at least 1 second, fractional allowed', () => {
    expect(field('refresh_interval').selector).toEqual({
      number: { min: 1, step: 0.5, mode: 'box', unit_of_measurement: 's' },
    });
  });

  it('offers a tap-to-live toggle and a live-duration slider, 5 to 60 seconds in steps of 5', () => {
    expect(field('tap_to_live').selector).toEqual({ boolean: {} });
    expect(field('live_duration').selector).toEqual({
      number: { min: 5, max: 60, step: 5, mode: 'slider', unit_of_measurement: 's' },
    });
  });
});

describe('computeLabel / computeHelper', () => {
  const named = [...form.schema, ...leaves].map((node) => node.name);

  it('labels and explains every field and group', () => {
    for (const name of named) {
      expect(form.computeLabel({ name }), name).toBeTruthy();
      expect(form.computeHelper({ name }), name).toBeTruthy();
    }
  });

  it('says where overlay_text and the escape hatch apply', () => {
    expect(form.computeHelper({ name: 'overlay_text' })).toMatch(/only applies when/i);
    expect(form.computeHelper({ name: 'aspect_ratio' })).toMatch(/16:9/);
    expect(form.computeHelper({ name: 'reload_after_minutes_down' })).toMatch(/0 disables it/i);
  });

  it('falls back to the raw name for an unknown field', () => {
    expect(form.computeLabel({ name: 'not_a_field' })).toBe('not_a_field');
    expect(form.computeHelper({ name: 'not_a_field' })).toBeUndefined();
  });
});

describe('assertConfig', () => {
  it('accepts a minimal config', () => {
    expect(() => form.assertConfig({ type: CARD_TYPE, camera: 'camera.front_yard' })).not.toThrow();
  });

  it('accepts a config using every option', () => {
    expect(() => form.assertConfig(EVERY_OPTION)).not.toThrow();
  });

  it('keeps the GUI editor for a pre-0.3.0 config that still carries transport:', () => {
    // WebRTC is gone, but a dashboard written against 0.2.x must not be kicked
    // out to the YAML editor over a key that is now just another unknown one.
    expect(() =>
      form.assertConfig({ type: CARD_TYPE, camera: 'camera.front_yard', transport: 'webrtc' }),
    ).not.toThrow();
  });

  it('accepts every example config in the README', () => {
    // Guard the guard: if the README parser silently produced junk, every
    // assertion below would pass vacuously. The fullest example is spelled out.
    expect(readmeExamples).toHaveLength(5);
    expect(readmeExamples[1]).toEqual({
      type: CARD_TYPE,
      camera: 'camera.front_yard',
      stream: 'front_yard_sub',
      overlay: 'custom',
      overlay_text: 'Front Yard',
      hold_action: { action: 'navigate', navigation_path: '/lovelace/cameras' },
      aspect_ratio: '16:9',
      reload_after_minutes_down: 30,
    });
    // The Snapshot mode example.
    expect(readmeExamples[3]).toEqual({
      type: CARD_TYPE,
      camera: 'camera.front_yard',
      mode: 'snapshot',
      refresh_interval: 4,
    });
    // The Tap to go live example, last in the file.
    expect(readmeExamples[4]).toEqual({
      type: CARD_TYPE,
      camera: 'camera.front_yard',
      mode: 'snapshot',
      tap_to_live: true,
      live_duration: 30,
    });

    for (const example of readmeExamples) {
      expect(() => form.assertConfig(example), JSON.stringify(example)).not.toThrow();
    }
  });

  /*
   * HA re-runs `assertConfig` on the config the form emits after every
   * keystroke, and a throw ejects the user to the YAML editor mid-edit. So the
   * guard's question is "can the form represent this?", not "is this valid?":
   * values a user necessarily types *through* are tolerated here even though
   * `normalizeConfig` (and therefore `setConfig`) still rejects every one of
   * them — see the matching cases in `card.test.ts`.
   */
  it('tolerates the invalid values a user types through', () => {
    const base = { type: CARD_TYPE, camera: 'camera.front_yard' };
    const transient: Record<string, unknown>[] = [
      // An empty picker: where every freshly added card starts.
      { type: CARD_TYPE },
      { ...base, camera: '' },
      // "0" and "0." on the way to "0.5"; a cleared box.
      { ...base, refresh_interval: 0 },
      { ...base, refresh_interval: Number.NaN },
      // "1" on the way to "10" — below the slider's 5 second minimum.
      { ...base, live_duration: 1 },
      { ...base, reload_after_minutes_down: -1 },
      // Every prefix of "16:9" spends a keystroke or two unparseable.
      { ...base, aspect_ratio: '16:' },
      { ...base, aspect_ratio: '' },
      { ...base, aspect_ratio: 0 },
      // Picking "Custom text" necessarily precedes typing it.
      { ...base, overlay: 'custom' },
      { ...base, overlay: 'custom', overlay_text: '' },
      // A stream box cleared on the way to a new sub-stream name.
      { ...base, stream: '' },
    ];
    for (const config of transient) {
      expect(() => form.assertConfig(config), JSON.stringify(config)).not.toThrow();
      expect(() => normalizeConfig(config), JSON.stringify(config)).toThrow();
    }
  });

  it('rejects what the form cannot represent, with normalizeConfig’s message', () => {
    const base = { type: CARD_TYPE, camera: 'camera.front_yard' };
    expect(() => form.assertConfig('not a mapping')).toThrow(/expected a YAML mapping/);
    expect(() => form.assertConfig({ ...base, mode: 'stills' })).toThrow(/"mode" must be one of/);
    expect(() => form.assertConfig({ ...base, overlay: 'label' })).toThrow(
      /"overlay" must be one of/,
    );
    // Right key, wrong type: no number box emits a string, so this is a config
    // the form would silently rewrite rather than round-trip.
    expect(() => form.assertConfig({ ...base, refresh_interval: '4' })).toThrow(
      /"refresh_interval"/,
    );
    expect(() => form.assertConfig({ ...base, live_duration: '60' })).toThrow(/"live_duration"/);
    expect(() => form.assertConfig({ ...base, tap_to_live: 'yes' })).toThrow(/"tap_to_live"/);
    expect(() => form.assertConfig({ ...base, camera: 42 })).toThrow(/entity id/);
    expect(() => form.assertConfig({ ...base, camera: 'sensor.front_yard' })).toThrow(
      /must be a camera entity/,
    );
    expect(() => form.assertConfig({ ...base, overlay_text: 7 })).toThrow(/"overlay_text"/);
    expect(() => form.assertConfig({ ...base, aspect_ratio: true })).toThrow(/"aspect_ratio"/);
    expect(() => form.assertConfig({ ...base, tap_action: 'more-info' })).toThrow(
      /must be an action object/,
    );
    expect(() => form.assertConfig({ ...base, hold_action: { action: 'explode' } })).toThrow(
      /"hold_action.action" must be one of/,
    );
  });

  it('passes through anything the validator throws that is not a transient ConfigError', () => {
    const boom = new TypeError('validator blew up');
    const stubbed = buildConfigForm(() => {
      throw boom;
    });
    expect(() => stubbed.assertConfig({})).toThrow(boom);

    // The duck-typed check needs both halves: the name and the flag.
    const namedOnly = buildConfigForm(() => {
      throw Object.assign(new Error('nope'), { name: 'ConfigError' });
    });
    expect(() => namedOnly.assertConfig({})).toThrow(/nope/);
    const flagOnly = buildConfigForm(() => {
      throw Object.assign(new Error('nope'), { transient: true });
    });
    expect(() => flagOnly.assertConfig({})).toThrow(/nope/);
  });
});

describe('SimplerCameraCard.getConfigForm', () => {
  it('returns the wired form', () => {
    const wired = SimplerCameraCard.getConfigForm();
    expect(wired.schema).toEqual(form.schema);
    expect(wired.computeLabel({ name: 'camera' })).toBe('Camera');
    expect(() =>
      wired.assertConfig({ type: CARD_TYPE, camera: 'camera.front_yard' }),
    ).not.toThrow();
    // Wired to the real validator: a structural failure still ejects to YAML,
    // a half-typed one does not.
    expect(() =>
      wired.assertConfig({ type: CARD_TYPE, camera: 'camera.front_yard', mode: 'stills' }),
    ).toThrow(/"mode" must be one of/);
    expect(() => wired.assertConfig({ type: CARD_TYPE })).not.toThrow();
  });
});
