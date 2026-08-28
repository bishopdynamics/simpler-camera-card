import { describe, expect, it } from 'vitest';
import { CARD_VERSION } from '../src/index';
import packageJson from '../package.json' with { type: 'json' };

describe('release metadata', () => {
  it('exposes a semver CARD_VERSION from the bundle entry point', () => {
    expect(CARD_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // The console banner (CARD_VERSION) is how a user checks which bundle their
  // kiosk actually loaded, so it must never drift from the released version.
  // See README "Releasing": both fields move together.
  it('pins CARD_VERSION to package.json', () => {
    expect(CARD_VERSION).toBe(packageJson.version);
  });
});
