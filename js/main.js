// main.js — scene: stage, players, fixed-step sim loop, hitbox resolution.
//
// Controls (P1 single player): A/D move, Space jump, Shift dash,
//   J punch, K heavy; W/S are attack-direction modifiers:
//   W+J uppercut, W+K cartwheel, S+J sweep, S+K hammerfist;
//   in air: J air jab, K axe kick; during dash: J/K shoulder check.
// P2 (duel demo): Arrows move/jump, / dash, , (comma) jab, . (period) heavy.
// F1: toggle hitbox/hurtbox debug view.
//
// The simulation runs at a FIXED 60 Hz step (accumulator pattern) independent
// of the render rate, so frame data behaves identically on 60/144/165 Hz
// monitors — the single most important thing for "no lag" fighting feel.

const SIM_STEP = Fighter.STEP;

class FightScene extends Phaser.Scene {
  constructor() { super('fight'); }

  // ---- Level loader (js/levels.js registry) -------------------------------
  // ?level=dojo|rooftop|warehouse loads authored data (width/sky/floors/
  // platforms/spawns come from the level; ?width= still overrides for tests).
  // No level param = the old flat arena: ?mooks=N keeps working EXACTLY as
  // before on the arcade world (this.level stays null).
  loadLevel() {
    const q = new URLSearchParams(location.search);
    const name = (q.get('level') || (window.LEVELS || window.CUSTOM_LEVELS ? '' : '') || '').toLowerCase();
    // Editor PLAY TEST hands the map through the URL (?map=base64 JSON) so the
    // boot can't depend on localStorage — origins differ (LAN / tunnel / Pages)
    // and Pages may serve stale cached scripts. URL map beats everything.
    const mapParam = q.get('map');
    let lv = null;
    if (mapParam) {
      try { lv = JSON.parse(decodeURIComponent(escape(atob(mapParam)))); }
      catch (e) { lv = null; }   // corrupt param: fall through to the registry
    }
    if (!lv && name) {
      lv = (window.LEVELS && window.LEVELS[name])
        || (window.CUSTOM_LEVELS && window.CUSTOM_LEVELS[name]);
      if (!lv) {   // editor saves live in localStorage per origin too
        try {
          const all = JSON.parse(localStorage.getItem('stickfight.customLevels') || '{}');
          lv = all[name] || null;
        } catch (e) { /* private-mode throw: registry only */ }
      }
    }
    if (!lv) return null;
    const W = 1280;
    const wParam = q.get('width');
    const urlW = wParam === null ? NaN : Number(wParam);
    return {
      name,
      width: Number.isFinite(urlW) ? Math.max(W, Math.min(8192, urlW))
                                   : Math.max(W, lv.width || W),
      sky: lv.sky || [0x101423, 0x1b2440],
      p1x: lv.p1x != null ? lv.p1x : 200,
      respawnX: lv.respawnX != null ? lv.respawnX : (lv.p1x != null ? lv.p1x : 160),
      // floors[] solid slabs (top at groundY, gaps = pits); pillars[] solid
      // columns standing on the floor (top landable, sides are walls).
      floors: (lv.floors || []).map((f) => ({ x: f.x, w: f.w })),
      pillars: (lv.pillars || []).map((p) => ({
        x: p.x, w: p.w, top: this.groundY + (p.y || 0), bottom: this.groundY,
      })),
      spawns: lv.spawns || [],
    };
  }

  // World y of the floor slab under x, or null over a pit. Flat arena
  // (no level) -> always groundY. Floors are solid: ragdolls rest on them
  // too; a corpse falls INTO a pit and dies in the void.
  floorAt(x) {
    const lv = this.level;
    if (!lv) return this.groundY;
    for (const f of lv.floors) if (x >= f.x && x <= f.x + f.w) return this.groundY;
    return null;
  }

  // Highest SOLID surface at or below footY at x: floor slabs and pillar
  // tops (both solid). Returns null when over a pit / beside a pillar with
  // nothing under foot.
  surfaceUnder(x, footY) {
    const lv = this.level;
    let top = null;
    if (!lv) {
      if (footY >= this.groundY - 0.01) top = this.groundY;
    } else {
      for (const f of lv.floors)
        if (x >= f.x && x <= f.x + f.w && footY >= this.groundY - 0.01)
          top = (top === null) ? this.groundY : Math.max(top, this.groundY);
      for (const p of lv.pillars)
        if (x >= p.x && x <= p.x + p.w && footY >= p.top - 0.01)
          top = (top === null) ? p.top : Math.max(top, p.top);
    }
    return top;
  }

  // Which pillar (if any) our body rect is overlapping on its SIDE (not on
  // top). Returns { p, push } where push is the signed x correction to eject
  // us, or null. A body counts as "on top" (=> no wall) when its feet are at
  // or above the pillar top.
  pillarSide(ctrX, bodyBottom, halfW) {
    const lv = this.level;
    if (!lv) return null;
    for (const p of lv.pillars) {
      // vertical overlap: must extend meaningfully below the top to be a wall
      if (bodyBottom <= p.top + 4) continue;
      if (bodyBottom < p.top) continue;
      const bx0 = ctrX - halfW, bx1 = ctrX + halfW;
      if (bx1 <= p.x || bx0 >= p.x + p.w) continue;   // no horizontal overlap
      // eject to the nearer side
      const leftPush = p.x - bx1;          // negative: move left to clear left edge
      const rightPush = (p.x + p.w) - bx0; // positive: move right to clear right edge
      const push = (ctrX < p.x + p.w / 2) ? (leftPush - 0.5) : (rightPush + 0.5);
      return { p, push, wallDir: push > 0 ? -1 : 1 };  // wallDir = dir we were moving into
    }
    return null;
  }

  // One pass per sim tick AFTER the fighter loop (Phaser still integrates
  // positions on its own render-frame step; we own ALL grounding: floors,
  // pillar tops, pillar side-walls, pits — see the world-bounds height bump
  // in create()). Swept check (prev feet -> new feet) so high-speed knockback
  // can't tunnel through a pillar top.
  resolveGround() {
    const centerYFor = (top) => top - CFG.body.height / 2;
    for (const f of this.fighters) {
      if (f.gone) continue;
      if (f.dead) { this.ragdollGround(f); continue; }
      const b = f.body, half = CFG.body.width / 2;
      const x = f.sprite.x;
      const feet = f.sprite.y + CFG.body.height / 2;
      const vy = b.enable ? b.velocity.y : 0;   // ragdoll bodies are disabled
      const prev = (f._prevFeet === null || f._prevFeet === undefined) ? feet : f._prevFeet;
      f._prevFeet = feet;

      // Riding a solid surface (floor slab or pillar top)? Only while actually
      // SEATED near it (not rising, not fast-falling) and while the slab still
      // extends under us (walking off an edge drops normally). The +60 band
      // exists because arcade re-adds gravity every RENDER frame while we snap
      // per SIM step: a standing body drifts below the top between snaps.
      let surf = null;
      if (f._plat !== null && vy >= -1 && vy <= 90
          && feet >= f._plat - 3 && feet <= f._plat + 60
          && this.spanAt(f._plat, x)) {
        surf = { top: f._plat };
      }
      // Land: only when a FALLING foot swept through the surface top.
      if (!surf && vy >= 0) {
        const lo = Math.min(prev, feet), hi = Math.max(prev, feet);
        const lv = this.level;
        if (lv) {
          for (const p of lv.pillars) {
            if (x >= p.x - half && x <= p.x + p.w + half
                && hi >= p.top - 0.01 && lo <= p.top + 0.01
                && (surf === null || p.top > surf.top)) surf = { top: p.top };
          }
          // Floor: unconditional snap once feet at/below the line + slab under
          // us (a high-speed fall can straddle the sweep; once below it never
          // re-crosses). Pillar tops keep the swept rule so jumps pass by.
          if (x >= 0 && x <= lv.width && hi >= this.groundY - 0.01) {
            for (const fl of lv.floors) {
              if (x >= fl.x - half * 0.5 && x <= fl.x + fl.w + half * 0.5) {
                surf = { top: this.groundY }; break;
              }
            }
          }
        } else if (hi >= this.groundY - 0.01 && lo <= this.groundY + 0.01) {
          surf = { top: this.groundY };
        }
      }
      if (surf) {
        f._plat = surf.top;
        const cy = centerYFor(surf.top);
        if (f.sprite.y > cy) f.sprite.y = cy;
        if (b.enable && b.velocity.y > 0) b.setVelocityY(0);
        f._grounded = true;
        if (!f.dead) f.lastSafeX = x;    // pit-recovery anchor (live feet only)
      } else {
        f._grounded = false;
        f._plat = null;
      }

      // Pillar side-walls: solid — eject out of the column and kill velocity
      // driving into it (only when NOT seated on top; standing bodies skip via
      // the bodyBottom<=top guard inside pillarSide). Runs even when grounded
      // so a body-blocked mook leaning into a column stays pinned, not sunk.
      // RISING exemption is ONLY for AI vaulting (mook hop / sniper escape)
      // AND ONLY while actually rising: the climb needs horizontal drive to
      // survive (eject zeroes vx), but the DESCENT must stay solid or a fast
      // mook sails straight through the column (user bug). Falling bodies
      // that didn't clear the top get ejected off the face and land on the
      // near side — a failed vault bounces off the wall, not through it.
      // The player is never exempt (user: "the sides don't block me when I'm
      // jumping").
      const vaulting = f.ai && f.ai.dec &&
        (f.ai.dec.mode === 'hop' || f.ai.dec.mode === 'vault')
        && !f._grounded && b.enable && b.velocity.y < 0;
      const side = this.pillarSide(f.sprite.x, f.sprite.y + CFG.body.height / 2, half);
      if (side) {
        // The position clamp ALWAYS runs: no body ever ends up inside a
        // column below its top — rising included (user bug round 2: the old
        // full exemption let a dashing jumper sail clean through a thin
        // pillar while still below the top line). Vaulting only spares the
        // VELOCITY: drive survives, x clamps to the face, so the mook slides
        // UP the wall face and tops out (drive zeroed every tick could never
        // reach the top). Everyone else hits the wall dead.
        f.sprite.x += side.push;
        if (!vaulting && b.enable && side.wallDir
            && b.velocity.x * side.wallDir > 0) b.setVelocityX(0);
        b.updateFromGameObject();
      }

      // Pit death / respawn (live fighters only — ragdolls handled above).
      const cy0 = centerYFor(this.groundY);
      if (f.sprite.y > cy0 + 60) {
        if (f.ai) { this.killInPit(f); continue; }
        this.playerPitRecover(f);
      }
    }
  }

  // Slab span (x0..x1) of the surface whose top is at `top` containing x —
  // floor slabs and pillar tops are both solid landable surfaces now. MUST
  // return null off the edge: a truthy fallback read as "slab still under
  // us" forever and let a fighter walk off a pillar into Wile E. Coyote
  // air-standing until the next jump.
  spanAt(top, x) {
    const lv = this.level;
    const floors = lv ? lv.floors : [{ x: 0, w: this.levelWidth }];
    if (top === this.groundY) {
      for (const fl of floors)
        if (x >= fl.x && x <= fl.x + fl.w) return { x0: fl.x, x1: fl.x + fl.w };
      return null;
    }
    for (const p of (lv ? lv.pillars : []))
      if (p.top === top && x >= p.x && x <= p.x + p.w) return { x0: p.x, x1: p.x + p.w };
    return null;
  }

  // A mook fell into a pit: outright death, corpse ragdolls into the void.
  // (Player pit = hp tax + reposition — see playerPitRecover; mooks have no
  // recovery so the pit is a stage hazard to be juke'd, Bruce Lee style.)
  killInPit(f) {
    f.takeHit({ damage: 999, knock: { x: 0, y: -260, hitstun: 0 } }, 1);
  }

  // Pit tax: 25 hp, reposition to last safe footing, brief hitstun so you
  // can't be combo'd the instant you're dropped back in.
  playerPitRecover(f) {
    f.health = Math.max(0, f.health - 25);
    const x = (f.lastSafeX != null ? f.lastSafeX : (this.level ? this.level.respawnX : f.sprite.x));
    const cy = this.groundY - CFG.body.height / 2;
    f.sprite.body.reset(x, cy);
    f._plat = this.groundY; f._prevFeet = this.groundY;
    f._grounded = true;
    f.hitstun = Math.max(f.hitstun, 30);
    f.invuln = 33;            // ~0.55 s: land, blink, get up (resolveHits skips)
    f.state = 'hurt';
    if (f.health <= 0) f.takeHit({ damage: 999, knock: { x: 0, y: 0, hitstun: 0 } }, 1);
  }

  // Ragdolls share the pit logic: a corpse over a gap keeps falling (limbs
  // keep flailing) until it's far below the floor line, then it's gone.
  ragdollGround(f) {
    const rd = f.ragdoll;
    if (!rd || rd.settled) return;
    // Floor under the corpse: floor slab OR a pillar top (surfaceUnder owns
    // both; null over a pit -> the corpse keeps falling and gets retired).
    const top = this.surfaceUnder(f.sprite.x, f.sprite.y + CFG.body.height / 2);
    const cy = (top === null ? this.groundY : top) - CFG.body.height / 2;
    f._ragFloor = (top === null) ? null : cy;
    const v = f.body.velocity;
    if (top !== null && f.sprite.y >= cy - 0.5 && v.y >= 0) {
      f.sprite.y = cy;
      if (v.y > 0) v.y = 0;
      f._ragGnd = true;
    } else if (top !== null && f.sprite.y >= cy - 0.5) {
      f._ragGnd = true;
    } else {
      f._ragGnd = false;
    }
    if (f.sprite.y > this.groundY + 80) {   // fell into a pit -> fade it out
      rd.settled = true; rd.freeze = null; rd.restLeft = Math.min(rd.restLeft || 60, 18);
    }
  }

  create() {
    const W = 1280, H = 720;
    this.groundY = 620;
    // ---- Level (js/levels.js) ---- must load before fighters/stage/bounds.
    this.level = this.loadLevel();
    // Level width (scrolling): ?width= overrides for testing; default = one
    // screen so the duel behaves exactly as before (camera clamps to 0).
    const urlW = Number(new URLSearchParams(location.search).get('width'));
    this.levelWidth = this.level ? this.level.width
      : (Number.isFinite(urlW) ? Math.max(W, Math.min(8192, urlW)) : W);
    // Camera subject: 'duel' = midpoint of the two fighters (classic FG cam),
    // 'follow' = P1 only with facing lookahead (?follow=1; this becomes the
    // mook-carving camera). Levels force follow cam (no duel in a level).
    this.camMode = (this.level || new URLSearchParams(location.search).get('follow')) ? 'follow' : 'duel';
    // Floor plane at groundY (620) so feet rest on the DRAWN floor line, not the canvas bottom.
    // Bottom bound sits BELOW groundY on levels so pits can exist: falling
    // into the void past resolveGround's pit-death line is what kills.
    this.physics.world.setBounds(0, 0, this.levelWidth, this.groundY + (this.level ? 240 : 0));
    this.physics.world.gravity.y = CFG.gravity;

    // ---- Stage art (drawn once, spans the whole level) ----
    const bg = this.add.graphics();
    const sky = this.level ? this.level.sky : [0x101423, 0x1b2440];
    // Sky.
    bg.fillGradientStyle(sky[0], sky[0], sky[1], sky[1], 1);
    bg.fillRect(0, 0, this.levelWidth, H);
    // Floor slabs: solid floors[] segments (gaps = pits) on levels; the old
    // single full-width slab on the flat arena.
    bg.fillStyle(0x2a3050, 1);
    const slabs = this.level ? this.level.floors.map((f) => ({ x: f.x, w: f.w }))
                             : [{ x: 0, w: this.levelWidth }];
    for (const s of slabs) {
      bg.fillRect(s.x, this.groundY, s.w, H - this.groundY + (this.level ? 240 : 0));
    }
    bg.lineStyle(3, 0x4a557e, 1);
    for (const s of slabs) bg.lineBetween(s.x, this.groundY, s.x + s.w, this.groundY);
    // Pit edge teeth so gaps read as hazards, not "the floor continues".
    if (this.level) {
      bg.lineStyle(2, 0x0a0d18, 1);
      for (const s of slabs) {
        bg.lineBetween(s.x, this.groundY, s.x, this.groundY + 24);
        bg.lineBetween(s.x + s.w, this.groundY, s.x + s.w, this.groundY + 24);
      }
      // Pillars: solid columns standing ON the floor — sides are walls, tops
      // are landable slabs (user: floating platforms read wrong).
      for (const p of this.level.pillars) {
        bg.fillStyle(0x232c4c, 1);
        bg.fillRect(p.x, p.top, p.w, this.groundY - p.top);
        bg.lineStyle(3, 0x6f86c8, 1);
        bg.lineBetween(p.x, p.top, p.x + p.w, p.top);        // landable top line
        bg.lineStyle(1.5, 0x39456e, 1);
        bg.lineBetween(p.x, p.top, p.x, this.groundY);       // side shading
        bg.lineBetween(p.x + p.w, p.top, p.x + p.w, this.groundY);
      }
    }
    // Back wall lanes for dojo depth.
    bg.lineStyle(1, 0x232b48, 1);
    for (let px = 100; px < this.levelWidth; px += 100) bg.lineBetween(px, 120, px, this.groundY);

    // ---- Fighters ----
    const mid = this.levelWidth / 2;
    const p1x = this.level ? this.level.p1x : mid - 220;
    this.p1 = new Fighter(this, p1x, this.groundY, 1, 0xf2f2f2);
    this.p2 = new Fighter(this, mid + 220, this.groundY, -1, 0x9ad0ff);
    this.p1.inputKey = 'p1'; this.p2.inputKey = 'p2';   // map to keyboard input slots
    // Starter character select (?char=..., user's request): katana = sword
    // stance, neutral J/K become slashes, both block bullets (guard boxes).
    // Full character-select UI comes later; URL boot is the test bed.
    if (new URLSearchParams(location.search).get('char') === 'katana') {
      this.p1.weapon = 'katana';
      this.p1.color = 0xbfe8d8;             // jade-tinted so it reads as ITS guy
    }
    // Master roster: everyone the sim steps, hits and separates. p1/p2 stay
    // as named refs (input + HUD); mooks append here (ai-driven).
    this.fighters = [this.p1, this.p2];

    // ---- Mooks: level spawns OR arena (?mooks=N on the right half) ----
    const urlM = Number(new URLSearchParams(location.search).get('mooks'));
    if (this.level) {
      // Level mode: solo vs the level's spawn zones. loadT = zones that fire
      // at once; trigger zones arm when P1 crosses their trigger x.
      this.fighters = [this.p1];
      this.spawnZones = [];
      this.mookCount = 0;
      for (const sp of this.level.spawns) this.mookCount += (sp.count || 1);
      for (const sp of this.level.spawns) {
        const zone = { x: sp.x, count: sp.count || 1, knobs: sp.knobs || {},
                       trigger: sp.trigger != null ? sp.trigger : null,
                       pillar: sp.pillar != null ? sp.pillar : null, done: false };
        this.spawnZones.push(zone);
        if (zone.trigger == null) this.fireZone(zone);
      }
    } else {
      this.mookCount = Number.isFinite(urlM) ? Math.max(0, Math.min(24, urlM)) : 0;
      if (this.mookCount > 0) {
        // Arena mode: solo vs mooks. P2 leaves the roster (not drawn/simulated/
        // hittable) — the duel shell stays available at mooks=0 for the boss.
        this.fighters = [this.p1];
        this.spawnMooks(this.mookCount);
      }
    }

    // ---- Input ----
    const kb = this.input.keyboard;
    kb.addCapture(Phaser.Input.Keyboard.KeyCodes.WASD);   // S = down modifier (W = up modifier now)
    kb.addCapture(Phaser.Input.Keyboard.KeyCodes.SPACE);  // jump: stop page scroll
    kb.addCapture(Phaser.Input.Keyboard.KeyCodes.ARROWS);
    kb.addCapture([Phaser.Input.Keyboard.KeyCodes.SHIFT,
                   Phaser.Input.Keyboard.KeyCodes.COMMA,
                   Phaser.Input.Keyboard.KeyCodes.PERIOD,
                   Phaser.Input.Keyboard.KeyCodes.SLASH,
                   Phaser.Input.Keyboard.KeyCodes.J,
                   Phaser.Input.Keyboard.KeyCodes.K]);
    this.keys = {
      // P1 (single-player): jump = SPACE; W is the UP attack-direction modifier
      // (up+attack = launcher), not a jump. S is the DOWN modifier (sweep/hammer).
      p1: { left: kb.addKey('A'), right: kb.addKey('D'), jump: kb.addKey('SPACE'),
            up: kb.addKey('W'), down: kb.addKey('S'),
            dash: kb.addKey('SHIFT'), jab: kb.addKey('J'), heavy: kb.addKey('K') },
      // P2 (duel demo shell): arrows; UP doubles as its jump and up-modifier.
      p2: { left: kb.addKey('LEFT'), right: kb.addKey('RIGHT'), jump: kb.addKey('UP'),
            up: kb.addKey('UP'), down: kb.addKey('DOWN'),
            dash: kb.addKey('SLASH'), jab: kb.addKey('COMMA'), heavy: kb.addKey('PERIOD') },
    };
    kb.on('keydown-F1', () => { Fighter.debug = !Fighter.debug; });

    // One-frame edge buffers: inputs pressed between sim steps still register.
    this.buffer = { p1: {}, p2: {} };
    for (const who of ['p1', 'p2']) {
      for (const act of ['jab', 'heavy', 'dash']) this.buffer[who][act] = 0; this.buffer[who].dashSrc = null;
    }
    // Wire edge-detect for one-shot actions.
    const wire = (who, act, key) => {
      key.on('down', () => {
        this.buffer[who][act] = 3;          // 3-step buffer window
        if (act === 'dash') this.buffer[who].dashSrc = 'shift';
      });
    };
    wire('p1', 'jab', this.keys.p1.jab);   wire('p1', 'heavy', this.keys.p1.heavy);
    wire('p1', 'dash', this.keys.p1.dash);
    wire('p2', 'jab', this.keys.p2.jab);   wire('p2', 'heavy', this.keys.p2.heavy);
    wire('p2', 'dash', this.keys.p2.dash);

    // ---- Double-tap-to-dash on direction keys ----
    // Two fresh downs of the same direction key within the window fire a dash.
    // e.repeat guard: browsers auto-repeat keydown while a key is HELD, which
    // would otherwise trigger a dash every ~30ms of holding.
    const TAP_WINDOW_MS = 260;
    const wireDoubleTap = (who, key) => {
      let lastTap = -1e9;
      key.on('down', (keyObj, domEvent) => {
        // Guard auto-repeat: holding a key must NOT read as a double-tap.
        // (Phaser may already suppress repeat, but don't depend on it.)
        if (domEvent && domEvent.repeat) return;
        const now = performance.now();
        if (now - lastTap <= TAP_WINDOW_MS) {
          this.buffer[who].dash = 3;
          this.buffer[who].dashSrc = 'tap';
          lastTap = -1e9;                    // need a fresh pair for another
        } else {
          lastTap = now;
        }
      });
    };
    wireDoubleTap('p1', this.keys.p1.left);
    wireDoubleTap('p1', this.keys.p1.right);
    wireDoubleTap('p2', this.keys.p2.left);
    wireDoubleTap('p2', this.keys.p2.right);

    // ---- Camera (render-side smoothing; sim stays camera-independent) ----
    // Manual follow (not startFollow) keeps us version-proof and gives the
    // exact duel/follow semantics below. Shake is an OFFSET on the followed
    // position, not an absolute scroll (the old behaviour).
    this.shakeT = 0; this.shakeMag = 0;
    this.camX = null;                        // eased view centre; lazy-init on frame 1
    this.cameras.main.setBounds(0, 0, this.levelWidth, H);

    // ---- HUD (screen-fixed: must not scroll with the world) ----
    this.hud = this.add.graphics();
    this.hud.setScrollFactor(0);

    // ---- STYLE (roguelike v1): ?style=1 arms the power system. ----
    if (new URLSearchParams(location.search).get('style') === '1') {
      this.style = new window.StyleManager(this);
      this.wave = 1;                     // scene object survives scene.restart(): reset escalation
      this.bullets = [];
      this.styleText = this.add.text(44, 108, '', { fontFamily: 'monospace', fontSize: '13px', color: '#9fe8c8' });
      this.styleText.setScrollFactor(0);
      this.styleBig = this.add.text(640, 300, '', { fontFamily: 'monospace', fontSize: '26px', color: '#ffffff', align: 'center' });
      this.styleBig.setOrigin(0.5).setScrollFactor(0).setVisible(false);
      const kbS = this.input.keyboard;
      const kQ = kbS.addKey('Q'), kE = kbS.addKey('E'), kR = kbS.addKey('R');
      const k1 = kbS.addKey('ONE'), k2 = kbS.addKey('TWO'), k3 = kbS.addKey('THREE');
      const kEnter = kbS.addKey('ENTER');
      // Guard: scene.restart() does NOT destroy the keyboard manager (the
      // empty shutdown handler keeps every Phaser object alive), so without
      // this each retry would stack a second copy of every listener.
      if (!this._styleKeysWired) {
        this._styleKeysWired = true;
        kQ.on('down', () => { if (this.style) this.style.slowHeld = true; });
        kQ.on('up',   () => { if (this.style) this.style.slowHeld = false; });
        kE.on('down', () => { if (this.style) this.style.pressImbue(); });
        kR.on('down', () => { if (this.style) this.style.pressDrain(); });
        const pick = (i) => () => {
          const st = this.style; if (!st) return;
          if (st.pending === 'offer') {
            st.pickOffer(i);
            // Arena roguelike: after the pick, the NEXT wave walks in. Level
            // mode keeps its own trigger-zone pacing (no forced respawn).
            if (!st.pending && !this.level && this.mookCount > 0) this.nextWave();
          }
        };
        k1.on('down', pick(0)); k2.on('down', pick(1)); k3.on('down', pick(2));
        kEnter.on('down', () => {
          const st = this.style; if (!st) return;
          if (st.pending === 'offer') {
            st.pickOffer(-1);                                      // Enter = skip
            if (!st.pending && !this.level && this.mookCount > 0) this.nextWave();
          }
          else if (st.pending === 'dead') this.scene.restart();    // Enter = retry run
        });
      }
    }

    this.acc = 0;
    this.game.events.once('shutdown', () => {});
  }

  sampleInput(who) {
    const k = this.keys[who], b = this.buffer[who];
    const inp = {};
    // Held states.
    inp.left = k.left.isDown;
    inp.right = k.right.isDown;
    inp.jumpHeld = k.jump.isDown;
    inp.down = !!k.down && k.down.isDown;   // DOWN modifier (sweep/hammerfist)
    inp.up   = !!k.up   && k.up.isDown;      // UP modifier (uppercut/cartwheel)
    // One-shot states consumed from buffer.
    inp.jump = b.jump > 0 || (k.jump.isDown && !this['prevJump_' + who]);
    this['prevJump_' + who] = k.jump.isDown;
    inp.jab = b.jab > 0;
    inp.heavy = b.heavy > 0;
    inp.dash = b.dash > 0;
    inp.dashSrc = b.dashSrc;
    inp.dashHeld = k.dash.isDown;
    inp.heldDir = k.left.isDown ? -1 : (k.right.isDown ? 1 : 0);
    // Decay buffers each sim step.
    for (const a of ['jab', 'heavy', 'dash']) if (b[a] > 0) b[a]--;
    if (b.dash === 0) b.dashSrc = null;
    return inp;
  }

  update(time, deltaMs) {
    // Fixed-step accumulator (clamped to avoid spiral-of-death after tab-out).
    this.acc += Math.min(deltaMs, 100) / 1000;
    let steps = 0;
    while (this.acc >= SIM_STEP && steps < 5) {
      this.simStep();
      this.acc -= SIM_STEP;
      steps++;
    }
    this.renderAll();
  }

  // ---- STYLE (roguelike v1, ?style=1) --------------------------------------
  // simGate: 1 = full sim; 0 = ONLY the player simulates (offer/death
  // overlay); f = BULLET TIME — non-player bodies are frozen by the arcade
  // (moves=false kills integration AND gravity — probe-verified on this
  // Phaser build) and re-integrated by hand at f-rate, while their AI,
  // frame counters, hitboxes and guard boxes hold. (world.timeScale is
  // GLOBAL and inverted here — set 0.25 measured 4x fast — so it can't
  // slow "everyone except you"; hand-driven gate instead.)
  stepFighter(f, inp, gate) {
    if (f.dead) { if (f.ragdoll && !f.gone) f.ragStep(gate === 1 ? SIM_STEP : gate * SIM_STEP); return; }
    const b = f.body;
    // gate === 0 hangs EVERYONE including the player (wave offer): arcade
    // integration is global, so leaving the player live while resolveGround
    // is gated would let gravity sink them through the floor under the text.
    if (gate === 0) {
      b.moves = false;
      f.hitboxes.length = 0; f.guardBoxes.length = 0;
      if (f.ai) f.aiIn = {};
      return;
    }
    if (gate === 1 || f.inputKey) {         // the player simulates at full speed
      b.moves = true;
      if (f.ai) f.ai.think(this.fighters);
      f.update(f.inputKey ? inp : (f.aiIn || {}));
      return;
    }
    // frozen mook: no brain, no clocks, no hitboxes, arcade sits out.
    if (f.ai) f.aiIn = {};
    f.hitboxes.length = 0; f.guardBoxes.length = 0;
    if (gate <= 0) { b.moves = false; return; }             // hang (offer/death)
    b.moves = false;                                        // manual integrate @ f
    b.velocity.y += CFG.gravity * SIM_STEP * gate;
    f.sprite.x += b.velocity.x * SIM_STEP * gate;
    f.sprite.y += b.velocity.y * SIM_STEP * gate;
    // Grounded clamp (manual pass only): arcade's per-step ground snap is
    // gated too, so WITHOUT this a footed mook sinks through the floor under
    // bullet time (gravity integrates at f-rate with no resolveGround).
    const feet = f.sprite.y + CFG.body.height / 2;
    const top = this.surfaceUnder(f.sprite.x, this.groundY);
    const surfTop = (top === null) ? this.groundY : top;
    if (feet >= surfTop) { f.sprite.y = surfTop - CFG.body.height / 2; b.velocity.y = 0; }
  }

  // ---- Mooks ----
  // A mook IS a player fighter with a MookAI attached: same class, same
  // moveset, same physics. Difficulty = knobs. Spawns on the right half.
  spawnMooks(n) {
    // Engagement queue (Bruce Lee one-at-a-time). OFF by DEFAULT: the queue
    // currently wedges (holder stalls ~320px, nothing lands — see
    // todocombat). Free-for-all is the known-good pack until that's fixed.
    // Test the queue with ?queue=1.
    const wantQueue = new URLSearchParams(location.search).get('queue') === '1';
    this.eng = wantQueue ? new EngagementManager({ slots: 1 }) : null;
    for (let i = 0; i < n; i++) {
      const x = Math.min(this.levelWidth - 80,
        this.levelWidth * 0.62 + i * 60 + (Math.random() * 40 - 20));
      const m = new Fighter(this, x, this.groundY, -1, 0xff8f5a);
      new MookAI(m, { mgr: this.eng });
      this.fighters.push(m);
    }
    if (this.style) this.style.offered = false;   // next wave clear re-offers
  }

  // Roguelike pacing (arena mode): each cleared wave walks in harder.
  // Escalation is knob-only (hp +3, aggression +0.05, capped) — same class,
  // same AI, no special cases. Style cap stays per-hit so big-HP waves pay
  // per OVERKILL, not per HP pool.
  nextWave() {
    this.wave = (this.wave || 1) + 1;
    const n = Math.min(8, this.mookCount);
    for (let i = 0; i < n; i++) {
      const side = (i % 2 === 0) ? 1 : -1;   // pressure from both sides
      const x = Math.max(60, Math.min(this.levelWidth - 60,
        this.p1.sprite.x + side * (380 + i * 55 + Math.random() * 40)));
      const m = new Fighter(this, x, this.groundY, x > this.p1.sprite.x ? -1 : 1, 0xff8f5a);
      new MookAI(m, {
        mgr: this.eng,
        hp: 12 + (this.wave - 1) * 3,
        aggression: Math.min(0.9, 0.55 + (this.wave - 1) * 0.05),
      });
      this.fighters.push(m);
    }
    this.mookCount = this.fighters.filter((f) => f.ai && !f.dead).length;  // HUD counter = live total (not corpses)
    if (this.style) this.style.offered = false;
  }

  // Level spawn zone: `count` mooks clustered around zone.x on the floor
  // there, facing the player; `knobs` merged into MookAI opts (elites).
  fireZone(zone) {
    if (zone.done) return;
    zone.done = true;
    if (!this.eng) {
      const wantQueue = new URLSearchParams(location.search).get('queue') === '1';
      this.eng = wantQueue ? new EngagementManager({ slots: 1 }) : null;
    }
    const px = this.p1 ? this.p1.sprite.x : 0;
    for (let i = 0; i < zone.count; i++) {
      let x, surfaceY;
      if (zone.pillar != null) {
        // Zone pinned to a pillar: mooks stand ON TOP (snipers, perch guards).
        const p = this.level.pillars[zone.pillar];
        x = p.x + 24 + (p.w - 48) * (zone.count === 1 ? 0.5 : i / (zone.count - 1))
            + (Math.random() * 10 - 5);
        surfaceY = p.top;
      } else {
        x = Math.max(60, Math.min(this.levelWidth - 60,
          zone.x + i * 56 + (Math.random() * 36 - 18)));
        // Spawn on whatever solid surface is over that x (floor or a pillar top).
        const top = this.surfaceUnder(x, this.groundY);
        surfaceY = (top === null) ? this.groundY : top;
      }
      const face = (px < x) ? -1 : 1;
      const k = zone.knobs || {};
      // Colour-codes the roster: gunners yellow, elites gold, mooks orange.
      const col = k.weapon ? 0xffe066 : (k.hp > 12 ? 0xffd166 : 0xff8f5a);
      const m = new Fighter(this, x, surfaceY, face, col);
      if (k.weapon) m.weapon = k.weapon;      // 'pistol' -> render + AI behaviour
      new MookAI(m, Object.assign({ mgr: this.eng }, k));
      m.lastSafeX = x;
      this.fighters.push(m);
    }
    if (this.style) this.style.offered = false;   // next wave clear re-offers
  }

  // Trigger zones fire when P1 walks past their trigger x (progress gates:
  // the far half of the level stays quiet until you get there).
  checkTriggers() {
    if (!this.spawnZones) return;
    for (const z of this.spawnZones) {
      if (!z.done && z.trigger != null && this.p1.sprite.x >= z.trigger) this.fireZone(z);
    }
  }

  // ---- Bullets (gunner mooks) — REAL projectiles, never hitscan (user:
  // wants to swipe them away with a katana someday). Each bullet is a point
  // mass integrated on the fixed sim step; any attack hitbox that overlaps it
  // (swatBullets, called from resolveHits' pass) deflects it. Bullets hit
  // fighters through takeHit; a bullet that hits its OWN shooter's side bounces
  // (no self-damage comedy loops). ----
  // The solid box a fighter is standing on (their perch), or null on flat
  // ground. Bullets and LOS give THIS box only the muzzle grace.
  pillarUnder(f) {
    const lv = this.level;
    if (!lv || !f) return null;
    const feet = f.y + CFG.body.height / 2;
    for (const p of lv.pillars) {
      if (f.x >= p.x && f.x <= p.x + p.w && Math.abs(feet - p.top) < 6) return p;
    }
    return null;
  }

  spawnBullet(o) {
    if (!this.bullets) this.bullets = [];
    this.bullets.push({
      x: o.x, y: o.y, vx: o.vx, vy: o.vy || 0,
      damage: o.damage, knock: o.knock, owner: o.owner,
      gracePillar: this.pillarUnder(o.owner),   // muzzle grace: own perch only
      life: 110,          // frames (~1.8s) — despawn so off-screen shots die
      swatted: 0,         // deflection counter (render + eventual katana flair)
    });
  }

  // Segment (x0,y0)->(x1,y1) vs AABB: true = segment crosses the box. The
  // bullet steps ~19px per frame; point-only sampling lets a steep shot graze
  // a pillar CORNER and straddle it between samples (user bug). Liang-Barsky.
  segBox(x0, y0, x1, y1, bx0, bx1, by0, by1) {
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    const slabs = [[-dx, x0 - bx0], [dx, bx1 - x0], [-dy, y0 - by0], [dy, by1 - y0]];
    for (const [p, q] of slabs) {
      if (Math.abs(p) < 1e-9) { if (q < 0) return false; }
      else {
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
        else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
    }
    return t0 <= t1;
  }

  stepBullets(gate = 1) {
    // gate scales time for projectiles (bullet time: they crawl, they don't
    // hang — the user's slow-mo slows EVERYONE except you, bullets included;
    // life is scaled too so a bullet's real flight time survives the slow-mo).
    const bs = this.bullets;
    if (!bs || !bs.length) return;
    for (const bl of bs) {
      if (bl.dead) continue;
      const px0 = bl.x, py0 = bl.y;
      bl.x += bl.vx * SIM_STEP * gate;
      bl.y += (bl.vy || 0) * SIM_STEP * gate;
      bl.life -= gate;
      if (bl.life <= 0) { bl.dead = true; continue; }
      // Walls: bullets die on the world edges (pillars block them too).
      if (bl.x < 4 || bl.x > this.levelWidth - 4 || bl.y > this.groundY + 30) {
        bl.dead = true; continue;   // y: die ON the floor, don't tunnel under it
      }
      // Pillars: SWEPT (segment) so no corner straddling. The muzzle grace
      // (first ~12 frames) exempts ONLY the shooter's own perch pillar — the
      // sniper needs to clear the box he stands on — every OTHER pillar is
      // solid from frame 0 (user bug: bullets cut corners through any pillar
      // near the muzzle while the grace blindly covered all of them).
      const lv = this.level;
      if (lv) for (const p of lv.pillars) {
        if (bl.gracePillar === p && bl.life > 98) continue;
        if (this.segBox(px0, py0, bl.x, bl.y, p.x, p.x + p.w, p.top, this.groundY)) {
          bl.dead = true;   // sparks: keep for a beat as a impact stub
          break;
        }
      }
      if (bl.dead) continue;
      // Hits: nearest live fighter whose body box the bullet sits inside.
      for (const f of this.fighters) {
        if (f.dead || f.gone || f.invuln > 0) continue;
        if (f === bl.owner && bl.life > 100) continue;  // don't eat the muzzle frame
        const dx = bl.x - f.sprite.x, dy = bl.y - f.sprite.y;
        if (Math.abs(dx) < CFG.body.width / 2 + 3 && Math.abs(dy) < CFG.body.height / 2 + 3) {
          bl.dead = true;
          f.takeHit({ damage: bl.damage, knock: bl.knock }, Math.sign(bl.vx) || 1);
          this.onHitFeedback({ damage: bl.damage });
          break;
        }
      }
    }
    this.bullets = bs.filter((b) => !b.dead);
  }

  // Katana-swipe HOOK: called with the scene's current attack hitboxes each
  // sim step (resolveHits). Any hitbox overlapping a bullet deflects it —
  // today that's "you can bat a bullet away with a punch", tomorrow it's the
  // katana's swipe box. Deflected bullets keep flying (reversed, slowed) with
  // owner cleared so they can hit the shooter back; a second swat kills them.
  swatBullets(hitboxes) {
    if (!this.bullets || !this.bullets.length) return;
    for (const bl of this.bullets) {
      if (bl.dead) continue;
      for (const hb of hitboxes) {
        if (bl.x >= hb.x && bl.x <= hb.x + hb.w && bl.y >= hb.y && bl.y <= hb.y + hb.h) {
          if (bl.swatted === 0 && this.style) this.style.onSwat(hb.attacker);  // bat a bullet = energy
          bl.swatted++;
          bl.vx = -bl.vx * 0.65;                 // batted back, slower
          bl.vy = -(bl.vy || 0) * 0.65 - 40;     // flipped upward off the line (aimed shots included)
          bl.y -= 6 + Math.random() * 10;        // lifted off the line
          bl.owner = null;                       // defanged from its shooter
          bl.life = Math.min(bl.life, 45);
          if (bl.swatted >= 2) bl.dead = true;   // swat twice = swatted away
          break;
        }
      }
    }
  }

  // Laser sight for gunner shots AFTER their aim has committed (aimVec set
  // at atk.aimLock): the line is the promise — it shows exactly where the
  // locked bullet will fly, so stepping off it (or behind a pillar) dodges.
  renderSights() {
    const shooters = this.fighters.filter((f) =>
      f.ai && f.weapon && !f.dead && f.currentAttack === 'shoot'
      && f.aimVec && !f.firedShot);
    if (!shooters.length) {
      if (this.sightGfx) this.sightGfx.clear();
      return;
    }
    if (!this.sightGfx) { this.sightGfx = this.add.graphics(); this.sightGfx.setDepth(5); }
    const g = this.sightGfx;
    g.clear();
    const lv = this.level;
    for (const s of shooters) {
      const atk = Fighter.CFG.attacks.shoot;
      const mx = s.x + s.facing * 46, my = s.y + atk.fire.y;
      const sp = Math.hypot(s.aimVec.vx, s.aimVec.vy) || 1;
      const dx = s.aimVec.vx / sp, dy = s.aimVec.vy / sp;
      // Raycast the sight: clip at the first pillar box, the floor, or a
      // world edge — same death rules stepBullets uses, so the line's end is
      // truthful about where the bullet would die.
      let tMax = 1400;
      const clipSlab = (x0, x1, y0, y1) => {   // ray vs AABB entry distance
        const tx0 = (dx > 0 ? (x0 - mx) / dx : (dx < 0 ? (x1 - mx) / dx : Infinity));
        const tx1 = (dx > 0 ? (x1 - mx) / dx : (dx < 0 ? (x0 - mx) / dx : Infinity));
        const ty0 = (dy > 0 ? (y0 - my) / dy : (dy < 0 ? (y1 - my) / dy : Infinity));
        const ty1 = (dy > 0 ? (y1 - my) / dy : (dy < 0 ? (y0 - my) / dy : Infinity));
        const tIn = Math.max(Math.min(tx0, tx1), Math.min(ty0, ty1));
        const tOut = Math.min(Math.max(tx0, tx1), Math.max(ty0, ty1));
        if (tOut > 0 && tIn <= tOut && tIn > 0) tMax = Math.min(tMax, tIn);
      };
      if (lv) for (const p of lv.pillars) clipSlab(p.x, p.x + p.w, p.top, this.groundY);
      clipSlab(-1e9, 1e9, this.groundY + 30, 1e9);           // floor
      clipSlab(-1e9, 4, -1e9, 1e9);                            // left edge
      clipSlab(this.levelWidth - 4, 1e9, -1e9, 1e9);           // right edge
      const ex = mx + dx * tMax, ey = my + dy * tMax;
      // Pulse: brighter as the fire frame approaches; last 5 frames strobe.
      const prog = Math.min(1, s.attackFrame / (atk.startup + 1));
      const strobe = s.attackFrame >= atk.startup - 3
        ? (Math.floor(s.attackFrame / 2) % 2 ? 1 : 0.45) : 1;
      const alpha = (0.15 + 0.55 * prog) * strobe;
      g.lineStyle(1.5, 0xff5555, alpha);
      g.lineBetween(mx, my, ex, ey);
      g.fillStyle(0xff5555, alpha * 0.9);            // endpoint pip
      g.fillCircle(ex, ey, 2.2);
    }
  }

  renderBullets() {
    if (!this.bulletGfx && !(this.bullets && this.bullets.length)) return;  // never drawn yet
    if (!this.bulletGfx) { this.bulletGfx = this.add.graphics(); this.bulletGfx.setDepth(5); }
    const g = this.bulletGfx;
    g.clear();   // ALWAYS clear: skipping the clear when the last bullet died
                 // burned frozen tracers onto the world forever.
    if (!this.bullets) return;
    for (const bl of this.bullets) {
      const c = bl.swatted ? 0x9ad0ff : 0xffe08a;   // swatted ones read blue
      g.fillStyle(c, 1);
      const sp = Math.hypot(bl.vx, bl.vy || 0);
      if (sp > 1) {
        // oriented tracer along the velocity line (sniper shots are aimed)
        const nx = bl.vx / sp, ny = (bl.vy || 0) / sp;
        g.fillTriangle(bl.x - nx * 6 - ny * 1.6, bl.y - ny * 6 + nx * 1.6,
                       bl.x - nx * 6 + ny * 1.6, bl.y - ny * 6 - nx * 1.6,
                       bl.x + nx * 6, bl.y + ny * 6);
      } else {
        g.fillRoundedRect(bl.x - 5, bl.y - 2, 10, 4, 2);   // dead tracer
      }
    }
  }

  simStep() {
    // STYLE gate (roguelike v1): full speed unless the style manager is
    // holding the world (offer/death = 0) or bullet time is draining (f).
    const st = this.style;
    const gate = st ? (st.pending === 'offer' ? 0 : (st.slowActive ? st.slowFactor : 1)) : 1;
    // 'dead' overlay deliberately runs at gate 1 (ragdoll plays out under the
    // text); only the wave offer truly hangs the world.
    const i1 = this.sampleInput('p1');
    const i2 = this.sampleInput('p2');
    this.lastIn = { p1: i1, p2: i2 };   // press-intent for separateBodies
    for (const f of this.fighters) this.stepFighter(f, f.inputKey === 'p2' ? i2 : i1, gate);
    if (st) st.tick();
    if (this.eng && gate === 1) this.eng.tick();   // handoff cooldown pace
    if (gate === 1) this.checkTriggers();          // progress-gated spawn zones (levels)
    this.resolveHits();
    // Bullet pass (gunner mooks): any live attack hitbox may SWAT bullets
    // (the katana hook — a punch can bat one away today), then integrate.
    {
      const boxes = [];
      for (const f of this.fighters) {
        if (f.dead) continue;
        for (const hb of f.hitboxes) boxes.push(hb);
        // Sword GUARD boxes: block the whole wind-up (see Fighter.tickAttack)
        // — separate array, so the blade deflects steel without ever cutting
        // a fighter outside its damaging active frames.
        for (const gb of f.guardBoxes) boxes.push(gb);
      }
      if (boxes.length) this.swatBullets(boxes);
    }
    this.stepBullets(gate);
    this.separateBodies();
    // resolveGround ALWAYS runs: during bullet time the player still moves
    // at full speed and needs the floor/pillar snap; frozen mooks sit still
    // (manual clamp above) and the sweep checks are no-ops for them.
    this.resolveGround();                    // floors/platforms/pits (levels; arena = groundY)
    // STYLE: wave clear = the between-waves power offer (also refills armor).
    if (st && !st.pending && !st.offered && !this.p1.dead && this.mookCount > 0) {
      const liveMooks = this.fighters.some((f) => f.ai && !f.dead);
      const allSpawned = !this.spawnZones || this.spawnZones.every((z) => z.done);
      if (!liveMooks && allSpawned) st.offerNow();
    }
    // Reap despawned corpses. Cost note: settled ragdolls integrate NOTHING
    // (frozen still image) and the flailer cap bounds simultaneous live ones,
    // so thousands of accumulated corpses stay ~free until they fade.
    this.fighters = this.fighters.filter((f) => {
      if (!f.gone) return true;
      f.destroy();
      return false;
    });
  }

  resolveHits() {
    // Attack-box x every-other-fighter. One-hit-per-swing stays GLOBAL
    // (hitConfirmed): a swing connects with at most one target — right for
    // mook jabs; multi-target heavies become a per-attack flag later.
    const check = (attacker, defender) => {
      if (!attacker.hitboxes.length || defender.dead) return;
      if (defender.invuln > 0) return;   // pit-recovery grace (levels)
      const dRect = {
        x: defender.sprite.x - CFG.body.width / 2,
        y: defender.sprite.y - CFG.body.height / 2,
        w: CFG.body.width, h: CFG.body.height,
      };
      for (const hb of attacker.hitboxes) {
        if (this.overlaps(hb, dRect)) {
          defender.takeHit(hb, attacker.facing);
          attacker.hitConfirmed = true;
          this.onHitFeedback(hb);
          break;
        }
      }
    };
    for (const a of this.fighters) {
      if (a.dead) continue;
      for (const d of this.fighters) {
        if (d === a) continue;
        check(a, d);
      }
    }
  }

  overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  onHitFeedback(hb) {
    // Knockback-scaled shake.
    this.shakeT = 0.12;
    this.shakeMag = Math.min(14, 3 + hb.damage * 0.6);
    // STYLE: landing hits feeds energy; DRAIN converts dealt damage to HP.
    // (Bullet hits call this too — gate on attacker so a bullet hitting YOU
    // never "heals" you for its own damage.)
    if (this.style && hb.attacker === this.p1) { this.style.onPlayerHit(hb); this.style.healFor(hb.damage); }
  }

  // Body-block: fighters can't occupy the same space. Push apart AND kill
  // drive-into-contact velocity (option 2: hitting the opponent slows the
  // TRUE speed, so a blocked runner really stops instead of running in place
  // — the gait, being a function of real speed, then falls to idle on its
  // own; wallContact also freezes the stride phase to kill 1-frame lag).
  // Pairwise over the roster: O(n^2) but trivial below ~50 bodies; a spatial
  // grid is the answer if crowds ever get that big.
  //
  // DIRECTIONAL mook-vs-mook collision (user: the pack was hardening into one
  // wall — a retreating mook couldn't retreat because lined-up teammates
  // behind him blocked him, so knockback stopped mattering in a crowd).
  // Rule: two AI mooks are SOLID only when they're trying to go the SAME way
  // (so an attacking line spreads out instead of stacking on one spot). They
  // PHASE THROUGH each other when moving in OPPOSITE directions, or when
  // either is mid-knockback (hurt) — so a launched/slammed mook flies clean
  // through the pack and the pack can't be used as an immovable wall.
  // Player pairs (inputKey) are ALWAYS solid: the pin/duel body-block is
  // load-bearing and was not part of the complaint.
  separateBodies() {
    const fs = this.fighters;
    const intent = (f) => (f.inputKey && this.lastIn[f.inputKey]) || (f.aiIn) || {};
    const MOVE_EPS = 40;   // |vx| below this reads as "not really moving"
    const solid = (A, B) => {
      if (A.inputKey || B.inputKey) return true;            // any player pair: always solid
      if (A.hitstun > 0 || B.hitstun > 0) return false;     // mid-knockback: phase through
      const va = A.body.velocity.x, vb = B.body.velocity.x;
      const sa = Math.abs(va) > MOVE_EPS ? Math.sign(va) : 0;
      const sb = Math.abs(vb) > MOVE_EPS ? Math.sign(vb) : 0;
      if (sa !== 0 && sb !== 0 && sa !== sb) return false;  // opposite: phase through
      return true;                                          // same way / holding: solid
    };
    for (const f of fs) { f.wallContact = false; f.wallBlockDir = 0; }
    for (let i = 0; i < fs.length; i++) {
      if (fs[i].dead) continue;
      for (let j = i + 1; j < fs.length; j++) {
        if (fs[j].dead) continue;
        if (!solid(fs[i], fs[j])) continue;                 // non-solid AI pair: pass through
        const a = fs[i].sprite, b = fs[j].sprite;
        const dx = b.x - a.x;
        const overlap = CFG.body.width - Math.abs(dx);
        const vertical = Math.abs(a.y - b.y) < CFG.body.height;
        // STICKY touch (3px slop — push-apart equilibrium sits ~1px past
        // true contact; exact overlap flickered the flag and restart-accel
        // stuttered). Press-intent keeps the wall true while leaning.
        const touching = overlap > -3 && vertical;
        const dir = dx >= 0 ? 1 : -1;
        const inA = intent(fs[i]), inB = intent(fs[j]);
        if (touching) {
          // Accumulate OR: pressed by ANYbody counts as wall contact.
          if (inA.heldDir === dir)  { fs[i].wallContact = true; fs[i].wallBlockDir = dir; }
          if (inB.heldDir === -dir) { fs[j].wallContact = true; fs[j].wallBlockDir = -dir; }
          if (overlap > 0) {
            const push = overlap / 2 + 0.5;
            // Momentum-preserving separation (never body.reset, which zeroes vx):
            a.x -= dir * push;
            b.x += dir * push;
            // Kill only velocity driving INTO the other; knockback pointing
            // away, dash-aways and jukes survive untouched.
            if (dir * a.body.velocity.x > 0) a.body.setVelocityX(0);
            if (-dir * b.body.velocity.x > 0) b.body.setVelocityX(0);
            a.body.updateFromGameObject();
            b.body.updateFromGameObject();
          }
        }
      }
    }
  }

  makeLabels() {
    this.labels = [
      this.add.text(44, 54, 'P1  A/D Space Shift  J K  (W/S+atk)', { fontFamily: 'monospace', fontSize: '13px', color: '#8fa0c8' }),
      this.add.text(1236 - 220, 54, 'P2  Arrows / , .', { fontFamily: 'monospace', fontSize: '14px', color: '#8fa0c8' }),
    ];
    if (this.level) {
      this.labels[1].setText('LEVEL: ' + this.level.name.toUpperCase());
      this.labels.push(this.add.text(44, 74, 'DOWN+JUMP drops through a platform', { fontFamily: 'monospace', fontSize: '12px', color: '#5b6a94' }));
    }
    for (const t of this.labels) t.setScrollFactor(0);
  }

  // ---- Camera (render side only — the sim never reads it) ----
  // duel mode: centre on the midpoint of the fighters, zoomed out if they're
  //   far apart (classic FG cam, future boss cam).
  // follow mode: centre on P1 with facing lookahead (mook-carving cam).
  // Eased on render delta so 60 and 144 Hz feel identical; clamped by the
  // camera bounds Phaser enforces against the world.
  updateCamera() {
    const W = 1280, H = 720;
    let target;
    if (this.camMode === 'follow') {
      const look = this.p1.facing * 110;               // see what you run into
      target = this.p1.sprite.x + look;
    } else {
      const mid = (this.p1.sprite.x + this.p2.sprite.x) / 2;
      target = mid;
      // FG cam: don't let one fighter walk out of frame — clamp so both stay
      // visible when they're within a screen, else follow the midpoint.
      const span = Math.abs(this.p1.sprite.x - this.p2.sprite.x);
      if (span < W - 160) {
        const lo = Math.min(this.p1.sprite.x, this.p2.sprite.x) + (W - 160) / 2;
        const hi = Math.max(this.p1.sprite.x, this.p2.sprite.x) - (W - 160) / 2;
        target = (target < lo) ? lo : (target > hi ? hi : target);
      }
    }
    // Ease (rate normalised to 60 Hz; frame-rate independent).
    const r = Math.min(1, (this.game.loop.delta / 1000) * 9);
    if (this.camX === null) this.camX = target;
    this.camX += (target - this.camX) * r;

    // Shake decays on the fixed step (feels the same regardless of fps).
    let sx = 0, sy = 0;
    if (this.shakeT > 0) {
      this.shakeT -= SIM_STEP;
      sx = (Math.random() - 0.5) * this.shakeMag;
      sy = (Math.random() - 0.5) * this.shakeMag;
    }
    // centre -> scroll. Use setScroll (NOT scrollX=): setScroll clamps to the
    // camera bounds; the raw property bypasses clamping (screen-edge gaps).
    this.cameras.main.setScroll(this.camX - W / 2 + sx, sy);
  }

  renderAll() {
    for (const f of this.fighters) { if (!f.dead) f.render(); else if (f.ragdoll) f.renderRagdoll(); }
    this.renderBullets();
    this.renderSights();
    this.updateCamera();

    // HUD health bars.
    const g = this.hud;
    g.clear();
    const barW = 460, barH = 22, pad = 40;
    // P1 (left, drains right-to-left).
    g.fillStyle(0x000000, 0.55); g.fillRect(pad - 4, 28 - 4, barW + 8, barH + 8);
    g.fillStyle(0x22282e, 1); g.fillRect(pad, 28, barW, barH);
    g.fillStyle(0xf2b705, 1); g.fillRect(pad, 28, barW * this.p1.health / 100, barH);
    // P2 (right, drains left-to-right). In arena mode: mook counter instead.
    const rx = 1280 - pad - barW;
    const liveMooks = this.fighters.filter(f => f.ai && !f.dead).length;
    if (this.mookCount > 0 && liveMooks > 0) {
      g.fillStyle(0x000000, 0.55); g.fillRect(rx - 4, 28 - 4, barW + 8, barH + 8);
      g.fillStyle(0x22282e, 1); g.fillRect(rx, 28, barW, barH);
      g.fillStyle(0xff8f5a, 1); g.fillRect(rx + barW - barW * liveMooks / Math.max(1, this.mookCount), 28,
        barW * liveMooks / Math.max(1, this.mookCount), barH);
      if (!this.mookLabel) {
        this.mookLabel = this.add.text(rx + 8, 30, '', { fontFamily: 'monospace', fontSize: '15px', color: '#0b0b10' });
        this.mookLabel.setScrollFactor(0);
      }
      this.mookLabel.setText('MOOKS ' + liveMooks).setX(rx + 8);
    } else if (this.mookCount === 0 && !this.level) {
      g.fillStyle(0x000000, 0.55); g.fillRect(rx - 4, 28 - 4, barW + 8, barH + 8);
      g.fillStyle(0x22282e, 1); g.fillRect(rx, 28, barW, barH);
      const w2 = barW * this.p2.health / 100;
      g.fillStyle(0xff5a5a, 1); g.fillRect(rx + barW - w2, 28, w2, barH);
    }
    // Labels.
    this.labels || this.makeLabels();

    // ---- STYLE HUD: currency line + overlay (offer / death). No flashy
    // reward effects yet (user: core first) — text only. ----
    if (this.style) {
      this.styleText.setText(this.style.hudLine());
      const st = this.style;
      if (st.pending === 'offer') {
        const lines = ['WAVE CLEAR — pick a power (1/2/3, Enter = skip)', ''];
        (st.offerChoices || []).forEach((id, i) => {
          const d = window.STYLE_DEFS[id], nl = st.lvl(id) + 1;
          const cost = nl === 1 ? window.STYLE_T.costPerBuy : window.STYLE_T.upgradeCost[nl - 1];
          lines.push((i + 1) + '. ' + d.name + (nl > 1 ? ' LV' + nl : '') +
                     '  [' + cost + ' SP]  ' + d.desc);
        });
        lines.push('', 'SP: ' + st.pts);
        this.styleBig.setText(lines.join('\n')).setVisible(true);
      } else if (st.pending === 'dead') {
        this.styleBig.setText('RUN OVER — ' + st.kills + ' kills, ' + st.spEarned +
          ' SP earned\nEnter = retry').setVisible(true);
      } else {
        this.styleBig.setVisible(false);
      }
    }
  }
}

window.__GAME = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: 1280,
  height: 720,
  backgroundColor: '#08080c',
  physics: { default: 'arcade', arcade: { debug: false } },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: FightScene,
});