import { describe, expect, it } from 'vitest';
import { CARD_VERSION } from '../src/index';

describe('scaffolding smoke test', () => {
  it('exposes a card version, proving the Vitest + TS wiring works', () => {
    expect(CARD_VERSION).toBe('0.0.1');
  });
});
