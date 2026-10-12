# Combat TODO

Main game = carving through mooks. Duel format stays as the demo / boss-battle shell.

[ ] fighters array refactor: replace hardcoded sc.p1/sc.p2 with a list; resolveHits loops attack-box x every other fighter (hit-once per swing); separateBodies goes pairwise. Duel must behave byte-identically after.
[ ] Mook AI v0: fabricate the same input dict the keyboard makes (Fighter.update takes it blind) — approach/circle/attack/recover state machine with reaction delay + skill knobs. Spawn ~6 in a wide arena, telegraphed jabs. First carving moment.
[ ] Mook variants via knobs first (reaction delay, aggression, dash-usage), dedicated movesets only if knobs get boring. Boss = mook knobs maxed + custom move.
[ ] Weapons (chair/pipe/etc.) as attack-data swaps — reach/frame-data, still procedural drawing.
[ ] Wave pacing: spawn triggers per level, rest beats between waves, screen-wide pressure not all-at-once.
[ ] Combo/score feel: hit counter, damage scaling, KO flair (ragdoll fly-out on death — the one place ragdoll physics earns its keep).
[ ] KO death: ragdoll fly-out on mook death, then fade/respawn for next wave.
[ ] Hurt/knockback tuning pass for crowds: hitstun vs knockback so juggle states read on 1 target but crowds get pushed apart.
[ ] Friendly fire rules for mook attacks (mooks bonk each other? probably yes, it's comedy gold and it's a player tool).
