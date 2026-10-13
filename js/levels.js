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
//              (dormant: no shipped level uses gaps — see rooftop note).
//   pillars    [{x, w, y}] SOLID columns standing ON the floor. Top at height
//              y above groundY (negative = up); the box from top down to the
//              floor is SOLID — you bonk into the sides, mooks must hop them,
//              the top is a landable slab. (User: floating platforms read
//              wrong — everything stands on the ground now.)
//   spawns     [{x, count, trigger?, knobs?, pillar?}] mook zones. Without
//              trigger the zone spawns at load; with trigger it spawns when
//              P1 passes x. knobs merge into MookAI opts ({hp:24} = elite,
//              {weapon:'pistol'} = sniper: holds still on his perch, flees
//              when you close — hunt him down). pillar:<index> pins the zone
//              to that entry of pillars[] and drops the count mooks ON TOP of
//              it (x is then unused) — snipers belong up there.
window.LEVELS = {
  // The current flat arena as an explicit level.
  dojo: {
    width: 2600,
    sky: [0x101423, 0x1b2440],
    p1x: 200, respawnX: 160,
    floors: [{ x: 0, w: 2600 }],
    pillars: [],
    spawns: [
      { x: 1400, count: 4 },
      { x: 2150, count: 4, trigger: 900 },
    ],
  },
  // Rooftops: fire-escape columns, trigger-gated waves, elites + a gunner on
  // the far side. NO PITS (user call: mooks walk into them and no knockback
  // pushes anyone in — the floor-gap mechanic stays dormant in the loader).
  rooftop: {
    width: 3600,
    sky: [0x141a2e, 0x33284e],
    p1x: 140, respawnX: 120,
    floors: [{ x: 0, w: 3600 }],
    pillars: [
      { x: 1150, w: 150, y: -110 },   // stair column
      { x: 1700, w: 170, y: -190 },   // tall column: hop it or fight under it
      { x: 2520, w: 200, y: -205 },   // ledge wall
      { x: 2990, w: 150, y: -115 },
    ],
    spawns: [
      { x: 1000, count: 3 },          // left of the stair column (don't spawn inside it)
      { x: 2250, count: 4, trigger: 1500 },
      { x: 3350, count: 4, trigger: 2400 },
      { x: 2050, count: 2, trigger: 1500, knobs: { hp: 24, aggression: 1.6 } }, // elites
      { x: 0, count: 1, trigger: 2400, knobs: { weapon: 'pistol' }, pillar: 2 }, // sniper on the ledge wall
      { x: 0, count: 2, trigger: 1500, pillar: 1 },                 // perch guards on the tall column
    ],
  },
  // Warehouse: crate columns at two heights, three ganged waves + a gunner
  // behind the last crates.
  warehouse: {
    width: 3200,
    sky: [0x121826, 0x223048],
    p1x: 160, respawnX: 140,
    floors: [{ x: 0, w: 3200 }],
    pillars: [
      { x: 700,  w: 120, y: -150 },
      { x: 1030, w: 110, y: -70 },
      { x: 1500, w: 260, y: -200 },   // big crate stack: climb or go round
      { x: 2030, w: 110, y: -70 },
      { x: 2420, w: 120, y: -150 },
    ],
    spawns: [
      { x: 1100, count: 4 },
      { x: 2000, count: 4, trigger: 900 },
      { x: 2850, count: 4, trigger: 1900 },
      { x: 0, count: 1, trigger: 1900, knobs: { weapon: 'pistol' }, pillar: 4 }, // sniper on the tall crate
      { x: 0, count: 2, trigger: 900, pillar: 2 },                   // perch guards on the big crate
    ],
  },
};
