import { describe, expect, it } from 'vitest';
import { SimplerCameraCard, normalizeConfig } from '../src/card';
import {
  buildConfigForm,
  isConfigFormGroup,
  type ConfigForm,
  type ConfigFormField,
  type ConfigFormNode,
} from '../src/editor';
import { CARD_TYPE, OVERLAY_MODES, TRANSPORTS, type SimplerCameraCardConfig } from '../src/types';

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
  transport: 'mse',
  overlay: 'custom',
  overlay_text: 'Front Yard',
  tap_action: { action: 'more-info' },
  hold_action: { action: 'none' },
  double_tap_action: { action: 'none' },
  aspect_ratio: '16:9',
  reload_after_minutes_down: 30,
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
    expect(topLevel).toEqual(['camera', 'transport', 'overlay', 'overlay_text', 'aspect_ratio']);
  });

  it('picks the camera with a Frigate-filtered entity selector', () => {
    expect(field('camera').required).toBe(true);
    expect(field('camera').selector).toEqual({
      entity: { filter: { integration: 'frigate', domain: 'camera' } },
    });
  });

  it('offers exactly the transports and overlay modes validation accepts', () => {
    const options = (name: string): { value: string; label: string }[] =>
      (field(name).selector.select as { options: { value: string; label: string }[] }).options;

    expect(options('transport').map((o) => o.value)).toEqual([...TRANSPORTS]);
    expect(options('overlay').map((o) => o.value)).toEqual([...OVERLAY_MODES]);
    for (const name of ['transport', 'overlay']) {
      expect((field(name).selector.select as { mode: string }).mode).toBe('dropdown');
      for (const option of options(name)) expect(option.label).not.toBe('');
    }
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

  it('accepts every example config in the README', () => {
    // Guard the guard: if the README parser silently produced junk, every
    // assertion below would pass vacuously. The fullest example is spelled out.
    expect(readmeExamples).toHaveLength(3);
    expect(readmeExamples[1]).toEqual({
      type: CARD_TYPE,
      camera: 'camera.front_yard',
      stream: 'front_yard_sub',
      transport: 'webrtc',
      overlay: 'custom',
      overlay_text: 'Front Yard',
      hold_action: { action: 'navigate', navigation_path: '/lovelace/cameras' },
      aspect_ratio: '16:9',
      reload_after_minutes_down: 30,
    });

    for (const example of readmeExamples) {
      expect(() => form.assertConfig(example), JSON.stringify(example)).not.toThrow();
    }
  });

  it('rejects what normalizeConfig rejects, with its message', () => {
    expect(() => form.assertConfig({ type: CARD_TYPE })).toThrow(/"camera" is required/);
    expect(() =>
      form.assertConfig({ type: CARD_TYPE, camera: 'camera.a', transport: 'rtsp' }),
    ).toThrow(/"transport" must be one of/);
    expect(() =>
      form.assertConfig({ type: CARD_TYPE, camera: 'camera.a', overlay: 'custom' }),
    ).toThrow(/requires "overlay_text"/);
    expect(() => form.assertConfig('not a mapping')).toThrow(/expected a YAML mapping/);
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
    expect(() => wired.assertConfig({ type: CARD_TYPE })).toThrow(/"camera" is required/);
  });
});
