# Steer the Eight

A steering trainer for novice coxswains. You cox a rowing eight seen from above: steer with the rudder, tell any seat or group to row, back it down, hold water or weigh enough, and watch how each rower moves the boat. A line under the river explains why the boat is doing what it does.

**Try it:** https://keckey.github.io/steer-the-eight/ (works in Safari on iPhone)

## Drills

- **Free row**: a river with bends, for getting a feel for the boat.
- **Hold your line**: starboard is stronger than port. Stay inside the buoys for 500 m.
- **Spin the boat**: turn around at a standstill, where the rudder can't help.
- **Stop short**: stop before a fallen tree. Weigh enough glides; hold water stops.
- **Through the arch**: line up for the one open arch of a bridge.

The Crew panel lets you make any rower stronger, weaker, early or late, to see what one rower does to the boat.

## Files

- `index.html`: the page, with the river view, controls and drawing.
- `sim.js`: boat and crew physics, drills and coaching hints. It has no page or drawing code, so it can be ported to Swift for a native iOS app.

## About the model

The physics is simplified and tuned to feel plausible. It is not validated against measurements of real boats, and it leaves out roll (the set), wind and stream.

## License

MIT
