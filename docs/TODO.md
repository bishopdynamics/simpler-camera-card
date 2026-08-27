# TODO List

This is the user-maintained TODO list; the only change the agent makes here is marking something done when it is. The user takes care of pruning completed items.

Items the agent deliberately deferred during implementation go to `docs/DEFERRED.md` instead; pull one in here when it's time to actually do it.

## Small Things

Little tweaks that do not warrant the full feature spec lifecycle.
If something here is actually bigger than it looks and really should be spec'd first, call that out and it goes through the full feature spec lifecycle (see Features below).

- Sometimes a camera stops streaming to Frigate, and Frigate switches to showing a card like "No frames have been received, check error logs"
  - this is an OK failure mode (our side is working fine, problem is the camera itself)
  - however, when that happens the camera card also displays an message that the camera entity has no "client_id" attribute, incorrectly concluding that this is not a frigate camera provided by frigate-hass-integration >=5.12.0
  - in this case, the camera stream is technically working, and we already have the "No frames" error message visible
  - so we dont need to reconnect (its working) and we dont need to display the "client_id" error message
  - ✅ **done (v0.1.1):** endpoint resolution now falls back to the last-known-good `client_id`/`camera_name` when HA strips the attributes of an unavailable entity, so reconnects keep working through a camera outage and the misleading error is gone; awaiting field confirmation on the kiosk

## Features

A feature must first be planned (user idea → research and discuss → improved idea → full feature spec), producing a spec file `docs/spec/FEATURE_SPEC_<thing>.md`. Then it can be implemented, following the spec.

- We _need_ visual editor support for this card
  - ✅ **done (v0.2.0, refined in v0.3.0):** `getConfigForm()` visual editor covering every option; field-verified by James
