# Initial Idea

name: Simpler Camera Card
one-liner: A simpler Home Assistant camera card for Frigate

## Summary

I currently use [Advanced Camera Card](https://github.com/dermotduffy/advanced-camera-card) for Home Assistant, to show camera feeds. All of my camera feeds come from Frigate (on a separate machine).

The Advanced Camera Card has gotten too advanced, and also become fairly unreliable. By that I mean that a camera stream on a long-running HA dashboard (like a wall kiosk) will eventually "blip" (some network issue probably, outside of the scope of this project) and then never recover; It used to recover gracefully.

I think its time to fork Advanced Camera Card, and rip out all the unnecessary junk we don't need, and make it more robust to network blips. 

I am currently using the `go2rtc` live view provider, because it seems to have the lowest impact client-side.

Things I _do not need_, that we can remove:

- multi-camera features (I only need one camera per card)
- casting / airplay
- ptz controls
- timeline
- menu, status bar, any of that extra UI

What I need:

- live view of a camera
- a couple options for how the live stream is achieved, with the most efficient as default
  - is go2rtc the most efficient?
- settings to customize what happens when I tap on a camera
  - this is one of the most annoying things missing from Advanced Camera Card, vs the builtin camera/image card
  - default: the "More details" view, which shows a bigger view of the camera
- option to use the lower-quality sub-stream of a camera
- option to overlay camera name (or custom text)


