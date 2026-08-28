/**
 * The README as an executable spec.
 *
 * Two things in it can silently rot: the options table (which must list exactly
 * the keys the card accepts) and the YAML examples (which must all still be
 * configs the card takes). Both are checked here against the real schema, so a
 * renamed option cannot ship with stale documentation.
 *
 * Everything that reads or parses the README lives in this file; the editor's
 * own schema tests are in `editor.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../src/card';
import { buildConfigForm, type ConfigForm } from '../src/editor';
import { CARD_TYPE } from '../src/types';
import { CONFIG_KEYS } from './fixtures';

const form: ConfigForm = buildConfigForm(normalizeConfig);

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

/**
 * The one example carrying every field in `signature`. Examples are addressed
 * by what makes them distinctive rather than by position, so adding one to the
 * README cannot renumber the expectations below; the "exactly one" rule keeps
 * an ambiguous signature from quietly matching the wrong block.
 */
function example(signature: Record<string, unknown>): Record<string, unknown> {
  const described = JSON.stringify(signature);
  const found = readmeExamples.filter((candidate) =>
    Object.entries(signature).every(([key, value]) => candidate[key] === value),
  );
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one README example matching ${described}, found ${found.length}`,
    );
  }
  return found[0];
}

describe('README', () => {
  it('matches the options documented in the README', () => {
    expect([...documentedKeys].sort()).toEqual([...CONFIG_KEYS].sort());
  });

  it('accepts every example config in the README', () => {
    // Guard the guard: if the README parser silently produced junk, every
    // assertion below would pass vacuously. The distinctive ones are spelled
    // out in full.
    expect(readmeExamples.length).toBeGreaterThanOrEqual(3);

    // The fullest example: a sub-stream, a custom overlay and a hold action.
    // (`stream:` alone would also match the sub-stream snippet further down.)
    expect(example({ stream: 'front_yard_sub', overlay: 'custom' })).toEqual({
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
    expect(example({ mode: 'snapshot', refresh_interval: 4 })).toEqual({
      type: CARD_TYPE,
      camera: 'camera.front_yard',
      mode: 'snapshot',
      refresh_interval: 4,
    });
    // The Tap to go live example.
    expect(example({ mode: 'snapshot', tap_to_live: true })).toEqual({
      type: CARD_TYPE,
      camera: 'camera.front_yard',
      mode: 'snapshot',
      tap_to_live: true,
      live_duration: 30,
    });

    for (const config of readmeExamples) {
      expect(() => form.assertConfig(config), JSON.stringify(config)).not.toThrow();
    }
  });
});
