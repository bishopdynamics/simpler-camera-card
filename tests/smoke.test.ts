import { describe, expect, it } from 'vitest';
import { CARD_VERSION } from '../src/index';
import packageJson from '../package.json' with { type: 'json' };

describe('scaffolding smoke test', () => {
  it('exposes a card version, proving the Vitest + TS wiring works', () => {
    expect(CARD_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // The console banner (CARD_VERSION) is how a user checks which bundle their
  // kiosk actually loaded, so it must never drift from the released version.
  // See README "Releasing": both fields move together.
  it('keeps CARD_VERSION in step with package.json', () => {
    expect(CARD_VERSION).toBe(packageJson.version);
  });
});
