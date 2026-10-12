# Levels TODO

Scrolling screens + level data + in-game editor. No tooling installs, no server: levels are JSON in the repo, editor is an edit-mode of the same page, GitHub Pages serves it all.

[x] Camera: startFollow(player) with lerp + facing lookahead; shake becomes an offset on the follow pos, not an absolute scroll. Lerp on render side, camera-locked feel on sim side (same render/sim split as animation).
    -> Done (manual follow, not startFollow — version-proof + duel/follow semantics). duel mode = midpoint cam with "keep both on screen" clamp (future boss cam); follow mode = P1 + 110px facing lookahead (?follow=1). Eased on render delta (fps-independent), shake is now an additive offset on the followed pos. HUD/labels setScrollFactor(0). Audited at width 4000: follow scroll = p1x+110-640 exactly (1270); right edge clamps to 2720 (=4000-1280), left to 0; duel cam keeps both fighters framed; shake settles back to anchor; default ?-less URL = width 1280, scroll 0 (old behavior).
[x] Wide world: world bounds from level width (e.g. 4000px), keep duel working at any width.
    -> Done: levelWidth from ?width= (clamped 1280..8192, default one screen); bg art + physics bounds + camera bounds all span levelWidth; fighters collideWorldBounds already true. Jab lands in wide world (100->94) at x~1800.
[ ] Level JSON format: width, solid platforms (x,y,w,h), spawn zones (x,y,type,count,trigger), decor. Loader via ?level=name.
[ ] Hand-written test level (rooftop: a few platforms, 3 spawn zones) + loader wired.
[ ] In-game edit mode: key toggles edit mode; click place/erase platforms + spawners with live physics; Export dumps JSON to clipboard/file.
[ ] Level select screen (pick from repo levels + local/imported JSON).
[ ] Parallax background layers (cheap: draw-on-canvas layers scrolling at fractions).
[ ] Bounds/fall handling: pits kill or bounce? decide per level field.
[ ] Editor niceties as needed: snap grid, object list panel, undo. Defer until editor hurts.
