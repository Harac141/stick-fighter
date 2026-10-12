# stick-fighter

A browser stick-figure fighting game prototype in the spirit of Star Fetchers,
Stick Fight, and Your Only Move Is Hustle — built with Phaser 4, procedurally
animated stick figures (live IK, no sprite sheets), fixed 60 Hz simulation,
frame-data-driven combat.

Two players on one keyboard:

|        | Player 1 | Player 2          |
|--------|----------|-------------------|
| Move   | A / D    | Left / Right      |
| Jump   | W        | Up                |
| Dash   | Shift    | /                 |
| Jab    | J        | , (comma)         |
| Heavy  | K        | . (period)        |

Double-tap a direction to dash. F1 toggles hitbox/hurtbox debug view.

## Run locally

Any static server works:

```
python3 -m http.server 8000
```

Then open http://localhost:8000/. The pose inspector (every animation state
rendered as 8-frame strips) is at /animlab.html.

## Layout

- `index.html` — game entry
- `animlab.html` — animation pose lab
- `js/fighter.js` — state machine, movement, dash, attacks, frame data, procedural gait/IK
- `js/main.js` — scene, fixed-step loop, input, HUD, hit resolution
- `js/animlab.js` — pose-lab harness
- `phaser.min.js` — pinned Phaser 4.2.1 build (no CDN dependency)
