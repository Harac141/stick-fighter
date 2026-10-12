# Combat TODO

Main game = carving through mooks. Duel format stays as the demo / boss-battle shell.

[x] fighters array refactor: replace hardcoded sc.p1/sc.p2 with a list; resolveHits loops attack-box x every other fighter (hit-once per swing); separateBodies goes pairwise. Duel must behave byte-identically after.
    -> Done. scene.fighters roster; players keep inputKey 'p1'/'p2' (keyboard slots), AI fighters carry f.aiIn (same dict shape). resolveHits/separateBodies/renderAll loop the roster; dead flag (skip sim/hit/separate/render). Audited: p1/p2 keyboard both 250 vx, jab 100->94, real pin vx0+wall+idle+pinned-jab-lands, injected 3rd body: pairwise pin equilibrium gap 44, jab lands through roster loop, dead body passed through. One-hit-per-swing is GLOBAL (one target per swing) — revisit for multi-target heavies.
[x] Mook AI v0: fabricate the same input dict the keyboard makes (Fighter.update takes it blind) — approach/circle/attack/recover state machine with reaction delay + skill knobs. Spawn ~6 in a wide arena, telegraphed jabs. First carving moment.
    -> Done (js/mook.js + ?mooks=N arena; arena drops P2 from roster — duel shell intact at mooks=0). State machine wait/approach/circle/attack/back, decisions refresh every ~react frames and HOLD between (no per-frame optimal play), per-mook knob jitter + negative stT = staggered arrival pack. Knobs: react/aggression/dashChance/heavyChance/circleChance/range/backoffFrames. Audited at mooks=6: all approach (gaps 785->84px), pack separation 40px, landed 3 jabs on idle p1 (100->82), scripted jab-spam carved a mook 100->58+hurt. Friendly fire ON via roster hit loop (mook bonked mook). Mooks are plain Fighters: same frame data/gait/dash/wall-block, difficulty = knobs.
[ ] Mook variants via knobs first (reaction delay, aggression, dash-usage), dedicated movesets only if knobs get boring. Boss = mook knobs maxed + custom move.
[ ] Weapons (chair/pipe/etc.) as attack-data swaps — reach/frame-data, still procedural drawing.
[ ] Wave pacing: spawn triggers per level, rest beats between waves, screen-wide pressure not all-at-once.
[ ] Combo/score feel: hit counter, damage scaling, KO flair (ragdoll fly-out on death — the one place ragdoll physics earns its keep).
[ ] KO death: ragdoll fly-out on mook death, then fade/respawn for next wave.
[ ] Hurt/knockback tuning pass for crowds: hitstun vs knockback so juggle states read on 1 target but crowds get pushed apart.
[ ] Friendly fire rules for mook attacks (mooks bonk each other? probably yes, it's comedy gold and it's a player tool).
