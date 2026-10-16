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
//   pillars    LEGACY [{x, w, y}] solid columns standing ON the floor —
//              kept for old custom maps; the loader folds them into blocks
//              (h = height, full column to the floor). Draw with BLOCK now.
//   blocks     [{x, w, y, h}] THE solid primitive: a rect with top at height
//              -y above ground (y negative = up) and thickness h downward
//              (bottom = ground + y + h, clamped to the floor). ALL FOUR
//              faces are solid: top lands you, underside bonks you (roofs!),
//              sides wall you. Buildings = lintel blocks over doorways +
//              roof blocks with a GAP between two segments (the gap IS the
//              skylight — absence of geometry, no special field needed).
//              skybox:true blocks are EDITOR MARKERS ONLY — no collision,
//              no LOS/blocking, invisible in game (mark planned openings).
//              {block:<index>} on a spawn drops the gang ON TOP of it.
//   spawns     [{x, count, trigger?, knobs?, block?}] mook zones. Without
//              trigger the zone spawns at load; with trigger it spawns when
//              P1 passes x. knobs merge into MookAI opts ({hp:24} = elite,
//              {weapon:'pistol'} = sniper: holds still on his perch, flees
//              when you close — hunt him down). block:<index> pins the zone
//              to that entry of blocks[] (or legacy pillars[]) and drops the
//              count mooks ON TOP of it (x is then unused) — snipers belong
//              up there.
window.LEVELS = {
  // The current flat arena as an explicit level.
  dojo: {
    desc: 'Flat concrete — where it all started. No cover, just fists.',
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
    desc: 'Fire-escape columns and ledge snipers. Mind the tall walls.',
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
    desc: 'Crate stacks at two heights. A sniper owns the tall crate.',
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
  // BREACH: the block-primitive showcase (user brief: "pistol goons shooting
  // at me from the skylight of a rooftop while I'm inside the building and I
  // have to fight my way up there"). One building, all blocks: two door
  // posts (gap = doorway), a raised interior floor (a step up AND hard cover
  // — the gunners' rays die on its edge), a sealed east wall, and a ROOF in
  // two segments — the gap between them IS the skylight (absence of
  // geometry; shots only fall through it, jumping anywhere else bonks on the
  // underside, 38px of standing headroom under the slabs). Roof top 230 up:
  // the interior floor's jump apex reaches 222 — you clear the roof ONLY by
  // launching up through the skylight gap and drifting onto its edge.
  // Second route: from the east yard hop the wall post (apex clears it by a
  // hair) and walk the roofline in.
  breach: {
    desc: 'Storm the building: gunners rain shots through the skylight. Fight up through it.',
    width: 1900,
    sky: [0x0e1322, 0x242a44],
    p1x: 140, respawnX: 120,
    floors: [{ x: 0, w: 1900 }],
    blocks: [
      // 0,1: door posts (gap 540..620 = the doorway; body 40 fits through).
      { x: 500,  w: 40,  y: -230, h: 230 },
      { x: 620,  w: 40,  y: -230, h: 230 },
      // 2: raised interior floor (60 step; also cover from roof-gun rays).
      { x: 540,  w: 700, y: -60,  h: 60 },
      // 3,4: ROOF slabs, 40 thick, top 230 up; the 900..980 gap is the
      // SKYLIGHT. Underside 190 up: bonk territory everywhere but the gap.
      { x: 660,  w: 240, y: -230, h: 40 },
      { x: 980,  w: 340, y: -230, h: 40 },
      // 5: sealed east wall (230 top = alternate roof entry from the yard).
      { x: 1240, w: 60,  y: -230, h: 230 },
      // 6: east yard crate (cover from the roof guns while you plan).
      { x: 1500, w: 120, y: -150, h: 150 },
    ],
    spawns: [
      { x: 850, count: 3 },                                     // inside, on the raised floor
      { x: 0, count: 1, trigger: 600, knobs: { weapon: 'pistol' }, block: 3 },  // gunner roof LEFT — pours through the skylight
      { x: 0, count: 1, trigger: 600, knobs: { weapon: 'pistol' }, block: 4 },  // gunner roof RIGHT
      { x: 0, count: 2, trigger: 1150, knobs: { hp: 24, aggression: 1.6 }, block: 3 }, // elites come down to meet you
      { x: 1650, count: 3, trigger: 1330 },                     // east yard when you pass the building
    ],
  },
};
