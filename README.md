# stick-fighter

A browser stick-figure fighting game prototype in the spirit of Star Fetchers,
Stick Fight, and Your Only Move Is Hustle — built with Phaser 4, procedurally
animated stick figures (live IK, no sprite sheets), fixed 60 Hz simulation,
frame-data-driven combat.

## Controls (single player)

Two attack buttons + context, Smash/Kirby-style. W and S are attack
*DIRECTION* modifiers, not movement — jump is SPACE.

|            | Key                        |
|------------|----------------------------|
| Move       | A / D (double-tap = dash)  |
| Jump       | Space (Shift also dashes)  |
| Punch      | J                          |
| Heavy      | K                          |
| Uppercut   | W + J  (launcher; from ground or run) |
| Cartwheel  | W + K  (two-hit rising kick) |
| Sweep      | S + J  (low hook, knockdown) |
| Hammerfist | S + K  (overhead smash)    |
| Air jab    | J in air                 |
| Axe kick   | K in air (forward-down chop, meteor) |
| Dash check | J or K during dash burst   |

Duel demo (2P on one keyboard, no mooks): P2 = arrows + `/` dash + `,` jab +
`.` heavy. F1 toggles hitbox/hurtbox debug view.

## Modes / URL parameters

| Param | Effect |
|-------|--------|
| `?mooks=N`   | arena: N AI mooks (drops P2). Cannon fodder = 2 jabs to KO |
| `?width=W`   | scrolling level width in px (1280–8192), camera follows |
| `?follow=1`  | follow-cam on P1 with facing lookahead (else duel midpoint cam) |
| `?queue=1`   | Bruce Lee engagement queue for mooks (experimental) |

Examples:
- Duel: `/`
- Mook arena: `/?width=4000&follow=1&mooks=6`

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
- `js/fighter.js` — state machine, movement, dash, attacks (CFG.attacks frame data),
  contextual `selectAttack`, procedural gait/IK
- `js/main.js` — scene, fixed-step loop, input, camera, HUD, roster, hit resolution
- `js/mook.js` — MookAI: fabricated-input brain (difficulty = knobs) + engagement queue
- `js/animlab.js` — pose-lab harness
- `phaser.min.js` — pinned Phaser 4.2.1 build (no CDN dependency)
- `todocombat.md`, `todomovement.md`, `todolevels.md` — live design + backlog
