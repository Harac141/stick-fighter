// levels.js — level registry. Plain data objects, same shape the future
// in-game editor will export (todocombat/todolevels). Served as a script so
// GitHub Pages needs no fetch/CORS; a JSON-file loader can sit behind this
// later without touching anything else.
//
// Shape:
//   width      world width in px (>= 1280)
//   sky        [topColor, bottomColor] gradient
//   p1x        player start x            respawnX  pit-recovery point
//   floors     [{x, w}] solid slabs, top at groundY; gaps between them = PITS
//   platforms  [{x, w, y}] ONE-WAY slabs: land from above, jump through from
//              below/sides. y = height above groundY (negative = up).
//   spawns     [{x, count, trigger?, knobs?}] mook zones. Without trigger the
//              zone spawns at load; with trigger it spawns when P1 passes x.
//              knobs merge into MookAI opts (e.g. {hp: 24} for an elite).
//
// PITS decision (todocombat open question): falling into a pit costs the
// player 25 hp + a reposition to their last safe footing; a mook who falls
// dies outright (ragdolls into the void). Levels decide where pits are by
// leaving floor gaps.
window.LEVELS = {
  // The current flat arena as an explicit level.
  dojo: {
    width: 2600,
    sky: [0x101423, 0x1b2440],
    p1x: 200, respawnX: 160,
    floors: [{ x: 0, w: 2600 }],
    platforms: [],
    spawns: [
      { x: 1400, count: 4 },
      { x: 2150, count: 4, trigger: 900 },
    ],
  },
  // Rooftops: one pit with a platform route across, fire-escape ledges,
  // trigger-gated waves, two elites guarding the far spawn.
  rooftop: {
    width: 3600,
    sky: [0x141a2e, 0x33284e],
    p1x: 140, respawnX: 120,
    floors: [
      { x: 0, w: 1450 },
      { x: 1700, w: 1900 },
    ],
    platforms: [
      { x: 1150, w: 230, y: -110 },   // step up before the pit
      { x: 1440, w: 270, y: -190 },   // across the pit (high)
      { x: 1870, w: 230, y: -105 },   // step down after the pit
      { x: 2520, w: 310, y: -205 },   // ledge wall to hop
      { x: 2990, w: 240, y: -115 },
    ],
    spawns: [
      { x: 1150, count: 3 },
      { x: 2250, count: 4, trigger: 1500 },
      { x: 3350, count: 4, trigger: 2400 },
      { x: 2050, count: 2, trigger: 1500, knobs: { hp: 24, aggression: 1.6 } }, // elites
    ],
  },
  // Warehouse: no pits, crate platforms at two heights, three ganged waves.
  warehouse: {
    width: 3200,
    sky: [0x121826, 0x223048],
    p1x: 160, respawnX: 140,
    floors: [{ x: 0, w: 3200 }],
    platforms: [
      { x: 700,  w: 360, y: -150 },
      { x: 1030, w: 160, y: -70 },
      { x: 1500, w: 420, y: -200 },
      { x: 2030, w: 160, y: -70 },
      { x: 2420, w: 360, y: -150 },
    ],
    spawns: [
      { x: 1100, count: 4 },
      { x: 2000, count: 4, trigger: 900 },
      { x: 2850, count: 4, trigger: 1900 },
    ],
  },
};
