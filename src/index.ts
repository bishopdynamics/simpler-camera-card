// Entry point for the Simpler Camera Card bundle.
//
// Importing `./card` for its side effect registers the custom element; this
// module only adds the Lovelace card-picker registry entry and logs the version
// banner (handy when a kiosk is serving a stale cached bundle).

import './card';
import { CARD_TAG } from './types';

export const CARD_VERSION = '0.5.1';

export { SimplerCameraCard, normalizeConfig } from './card';
export * from './types';

window.customCards = window.customCards ?? [];
if (!window.customCards.some((card) => card.type === CARD_TAG)) {
  window.customCards.push({
    // The picker registry wants the bare tag name, not the `custom:` form.
    type: CARD_TAG,
    name: 'Simpler Camera Card',
    description:
      'Single-camera Frigate live view via go2rtc, built to recover from network blips on ' +
      'long-running dashboards.',
    // No preview: rendering one would open a live stream for every card in the
    // picker list.
    preview: false,
    documentationURL: 'https://git.bishopdynamics.com/claude/simpler-camera-card',
  });
}

console.info(
  `%c SIMPLER-CAMERA-CARD %c v${CARD_VERSION} `,
  'color: white; background: #039be5; font-weight: 700;',
  'color: #039be5; background: white; font-weight: 700;',
);
