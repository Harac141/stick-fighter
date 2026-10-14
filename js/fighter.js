// fighter.js — stick-figure fighter: state machine + arcade movement + hitboxes.
//
// Design notes (fighting-game idioms):
//  - One Fighter = one arcade-physics body (the "hurtbox" block) + a Graphics
//    that draws the stick figure on top. Physics only ever sees the rectangle;
//    the stick figure is pure art. That's exactly how Star Fetchers / SF-style
//    fighters are built: boxes fight, skeletons just pose.
//  - All timing is expressed in FRAMES (1/60s) so frame data reads like a real
//    fighting game: startup / active / recovery per attack.
//  - Attacks spawn hitboxes only during "active" frames; hitboxes carry damage,
//    knockback, and a "hit once" guard.

const STEP = 1 / 60; // fixed simulation step
const THIGH = 24, SHIN = 24, UARM = 19, FARM = 18;  // rigid limb lengths
const BLEND = 0.35;  // render-pose easing per frame (~5-frame settle)

// Two-bone IK: given root + target and segment lengths, solve the joint.
// 'knee' bends toward facing; 'elbow' droops below the root->target line.
function ik2(rx, ry, tx, ty, l1, l2, kind, facing) {
  let dx = tx - rx, dy = ty - ry;
  let d = Math.hypot(dx, dy) || 0.001;
  const maxd = l1 + l2 - 0.01;
  if (d > maxd) { const s = maxd / d; tx = rx + dx * s; ty = ry + dy * s; dx = tx - rx; dy = ty - ry; d = maxd; }
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const mx = rx + dx * a / d, my = ry + dy * a / d;
  const px = dy / d, py = -dx / d;                 // right normal
  const candA = { x: mx + px * h, y: my + py * h };
  const candB = { x: mx - px * h, y: my - py * h };
  if (kind === 'knee') {
    return (candA.x - mx) * facing >= 0 ? candA : candB;   // knee leads facing
  }
  // Elbow ALWAYS trails the hand (never pops in front of the shoulder->hand
  // line mid-swing — that was the chicken-wing flip in the run pump).
  // Tie-break (perfectly horizontal arm): elbow droops below the hand.
  if (candA.x * facing !== candB.x * facing) return candA.x * facing < candB.x * facing ? candA : candB;
  return candA.y >= candB.y ? candA : candB;
}


// ---- Tunables ---------------------------------------------------------------
const CFG = {
  gravity: 1900,
  run:      { accel: 3000, turnDecel: 2600, maxSpeed: 250, friction: 500 },  // friction = release skid (tuned; was slider-bound during dev)
  air:      { accel: 1400, maxSpeed: 260 },
  jump:     { velocity: -920, cutMultiplier: 0.55 },   // variable jump height (v3: -640=108px apex couldn't clear platforms; -920 = ~223px full clears the 200px crates, ~85px tap hop)
  dash:     { burstSpeed: 560, burstFrames: 10, sprintSpeed: 450, cooldown: 26 },
  body:     { width: 40, height: 92 },
  // MAX GROUNDED FOOT OFFSET from hip is sqrt(48^2 - 37.5^2) ~ 30px (leg
  // 48 long, hip ~37.5 high) — so duty*stride must stay <= ~56 or the shin
  // visibly stretches at toe-off. That caps honest walk cadence here.
  // Walk cadence was too fast at 94. Bigger stride slows the steps, but the
  // rigidity ceiling caps how far a GROUNDED foot may sit from the hip (~56px
  // of stance sweep). Real animators cheat this with a touch of foot slip:
  // the foot scuffs forward ~8px per stance — invisible at speed, whereas a
  // 30px moonwalk (stride 150) was not.
  strideWalk:   112,   // px per cycle: ~2.2 steps/s at walk speed (was 2.7)
  walkSlip:     0.85,  // fraction of true planting (1.0 = zero slip)
  strideSprint: 150,   // px per cycle at sprint cadence (dash hold phase)
  // Ragdoll (fake physics — see Fighter.ragStep). Joints are damped pendulums;
  // the corpse's arcade body does the ballistic flight for free.
  ragdoll: {
    airK: 26, airC: 3.5,        // limb pendulum while airborne (underdamped=whips)
    sprawlFrames: 4,      // frames for the lie-down pose blend (user: "a couple frames")
    airDrag: 0.12,        // per-second corpse air drag (near-none: momentum!)
    groundFriction: 8,    // per-second slide decay once on the floor (stop fast)
    flailMaxFrames: 240,        // safety: force-freeze anything that never settles
    restFrames: 90,             // frozen "still image" hold before fading out
    fadeFrames: 45,
    maxLive: 8,                 // simultaneous airborne flailers (oldest force-freezes)
  },
  // Attacks: startup, active, recovery in frames; knockback vx/vy.
  attacks: {
    // ---- Jab = a 2-hit CHAIN that CANCELS into heavies (user: J-J-K). ----
    // Tapping J throws single light jabs: chip damage, LONG lone cooldown
    // (that's the "have to commit" tax). Pressing again inside the chain
    // window links jab1 -> jab2 (the tight pop-pop). The string has no third
    // link: instead, K (or W+K / S+K...) CANCELS out of jab2 into any heavy —
    // the finisher is the player's choice, and the whole heavy catalog
    // (heavy / cartwheel / hammerfist) becomes the combo's variety. Chain
    // state lives on the Fighter (chainStep/chainT), advanced in startAttack.
    jab: {                                      // AI free-poke (MookAI pulses
      startup: 2, active: 3, recovery: 5,       // inp.jab) — kept at the old
      damage: 6, pose: 'jab',                   // numbers: mob balance is
      box:   { x: 34, y: -14, w: 46, h: 22 }, // relative to fighter center, facing right
      knock: { x: 260, y: -140, hitstun: 14 },  // untouched by the player-chain
      cooldown: 6,                              // rework (user asked player-only)
    },
    jab1: {
      chain: true,
      startup: 2, active: 3, recovery: 5,
      linkFrom: 4,                              // pop 2 unlocks EARLY (frame 4):
                                                // mash = tight pop-pop        (user rhythm)
      damage: 3, pose: 'jab', lunge: 300,
      box:   { x: 34, y: -14, w: 46, h: 22 },
      knock: { x: 40, y: -20, hitstun: 9 },    // chip: freeze in place, keep the target in box range
      cooldown: 22,                             // dropped if the chain continues
    },
    jab2: {
      chain: true,
      startup: 3, active: 3, recovery: 8,
      cancelFrom: 5,                            // J-J-K (user): from mid-active
                                                // (and through the tax window)
                                                // HEAVY cancels out of pop 2
      damage: 3, pose: 'jab', lunge: 300,
      box:   { x: 32, y: -12, w: 48, h: 24 },  // other hand, slightly wider
      knock: { x: 45, y: -25, hitstun: 10 },   // still a chip; target stays put
      cooldown: 22,
    },
    heavy: {
      startup: 9, active: 5, recovery: 20,
      damage: 14, lunge: 600,
      box:   { x: 30, y: 4, w: 58, h: 26 },
      knock: { x: 520, y: -360, hitstun: 26 },
      cooldown: 14,
    },
    // ---- KATANA starter character (user: "a character with a sword", just
    // neutral light + heavy, both block bullets). Neutral-only: selectAttack
    // routes plain J / K to these when weapon==='katana'; W/S/air/dash fall
    // through to the normal body grammar (a starter, not a full moveset).
    // `guard` is a box published for the WHOLE wind-up+active window that
    // deflects bullets (guardBoxes pass) but never damages fighters — so
    // blocking is timing-lenient, unlike the damaging active hitbox.
    katLight: {
      weapon: 'katana',
      startup: 4, active: 4, recovery: 7,       // quick horizontal slash
      damage: 7, lunge: 220,
      pose: 'slashL',
      box:   { x: 34, y: -8, w: 62, h: 30 },    // chest-line cut
      guard: { x: 26, y: -22, w: 74, h: 66 },   // tall arc: catches chest bullets
      knock: { x: 340, y: -120, hitstun: 14 },
      cooldown: 10,
    },
    katHeavy: {
      weapon: 'katana',
      startup: 6, active: 4, recovery: 13,       // committed two-handed cleave (user: faster)
      damage: 17, lunge: 520,
      pose: 'slashH',
      box:   { x: 30, y: -4, w: 74, h: 54 },    // big reach cleave
      guard: { x: 22, y: -34, w: 86, h: 92 },   // wide guard: deflects the lane
      knock: { x: 560, y: -300, hitstun: 24 },
      cooldown: 16,
    },
    // ---- Contextual variants (two buttons + context, Smash/Kirby style) ----
    // pose tags drive computePose; air:true = airborne legs; hitFrames = multi-hit;
    // knockScale = knockback grows with attacker speed; meteor = downward spike.
    uppercut: {                                 // J while rising
      startup: 3, active: 4, recovery: 9,
      damage: 7, pose: 'upper', air: true,   // air:true = scripted legs (leg pose is the launch)
      box:   { x: 16, y: -30, w: 46, h: 52 },   // generous: covers body height from the ground
      knock: { x: 120, y: -600, hitstun: 22 },  // launcher: pops straight up
      cooldown: 8,
    },
    cartwheel: {                                // K while rising (Kirby up-smash)
      startup: 4, active: 10, recovery: 12,
      damage: 5, pose: 'cartwheel', air: true,   // scripted legs: the kick IS the pose
      hitFrames: [6, 10],                       // two hits: tick, then pop
      box:   { x: 12, y: -30, w: 60, h: 62 },   // generous arc
      knock: { x: 240, y: -560, hitstun: 18 },
      cooldown: 12,
    },
    sweep: {                                    // S+J grounded
      startup: 4, active: 4, recovery: 11,
      damage: 6, pose: 'sweep',
      box:   { x: 26, y: 26, w: 54, h: 16 },    // low hook at the ankles
      knock: { x: 300, y: -40, hitstun: 30 },   // knockdown: scrambles up slowly
      cooldown: 8,
    },
    hammerfist: {                               // S+K grounded
      startup: 10, active: 5, recovery: 17,
      damage: 18, pose: 'hammer',
      box:   { x: 22, y: -12, w: 48, h: 54 },
      knock: { x: 440, y: -260, hitstun: 28 },  // slow telegraph, enormous payoff
      cooldown: 14,
    },
    airjab: {                                   // J airborne
      startup: 3, active: 4, recovery: 6,
      damage: 5, pose: 'airjab', air: true,
      box:   { x: 24, y: -16, w: 42, h: 26 },
      knock: { x: 200, y: -120, hitstun: 12 },
      cooldown: 5,
    },
    axekick: {                                  // heavy (K) airborne
      startup: 5, active: 7, recovery: 8,
      damage: 11, pose: 'axe', air: true, meteor: true,
      box:   { x: 16, y: 16, w: 56, h: 44 },    // heel CHOPS forward-down: reaches mooks
      knock: { x: 200, y: 560, hitstun: 24 },   // ahead+below, no hovering to line up; meteor keeps
      cooldown: 8,
    },
    dashatk: {                                  // J/K during dash
      startup: 2, active: 5, recovery: 10,
      damage: 9, pose: 'dash',
      box:   { x: 30, y: -8, w: 48, h: 30 },    // shoulder check
      knock: { x: 140, y: -280, hitstun: 22 },  // knockback scales with dash speed
      knockScale: true,                         // + speed*0.8: 560 dash slams across arena
      cooldown: 10,
    },
    // Pistol (gunner mooks only; AI sets input.shoot). NOT hitscan: firing
    // spawns a travelling projectile (scene.spawnBullet) so bullets are
    // physical things a katana (future) — or any hitbox today — can swat.
    shoot: {
      startup: 20, active: 3, recovery: 24,     // long aim = readable telegraph
      aimLock: 10,                              // frame the aim COMMITS: after
                                                // this, moving dodges (the shot
                                                // no longer tracks); sight line
                                                // shows the committed vector
      damage: 8, pose: 'shoot',
      box:   { x: 40, y: -14, w: 2, h: 2 },     // muzzle marker only (bullet does the damage)
      fire:  { speed: 1150, y: -14 },            // px/s (user: gunner bullets FAST); no gravity — straight line reads as a bullet
      knock: { x: 180, y: -120, hitstun: 12 },  // bullet pop on the victim
      cooldown: 34,
    },
  },
};

// Facing: 1 = right, -1 = left.

class Fighter {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} x initial center x
   * @param {number} groundY world y of the floor surface (feet rest here)
   * @param {number} facing initial facing
   * @param {number} color stick-figure line colour
   */
  constructor(scene, x, groundY, facing, color = 0xf2f2f2) {
    this.scene = scene;
    this.color = color;
    this.facing = facing;

    const h = CFG.body.height;
    const bodyY = groundY - h / 2; // body is centered, feet sit on groundY

    // Invisible physics sprite; the rectangle body IS the hurtbox.
    this.sprite = scene.physics.add.existing(
      scene.add.zone(x, bodyY, CFG.body.width, CFG.body.height)
    );
    const b = this.sprite.body;
    b.setAllowGravity(true);
    b.setCollideWorldBounds(true);
    b.checkCollision.down = false;  // side walls stay; world BOTTOM lets bodies
                                    // fall past into pits (levels) — resolveGround
                                    // owns all grounding, world height is slack.
    b.setDamping(true);
    b.setDragX(0); // we apply our own friction per-state

    // Stick-figure art layer.
    this.gfx = scene.add.graphics();

    // ---- State ----
    this.state = 'idle';       // idle|run|jump|fall|dash|attack|hurt
    this.health = 100;
    this.dead = false;       // KO'd: sim skips (render/separate/hit). ragdoll object drives the corpse.
    this.ragdoll = null;     // fake-physics corpse state (see ragStep); set by ko()
    this.gone = false;       // corpse despawned; scene filters it out of the roster
    this.animTime = 0;         // seconds, drives idle bob
    this.cyclePhase = 0;       // 0..1 gait phase, advanced by ACTUAL speed (no foot slip)
    this.wallContact = false;  // scene sets true when body-blocked by opponent
    // ---- Level ground state (scene.resolveGround owns these; see main.js) ----
    this._plat = null;         // top-y of the surface we're standing on, or null
    this._prevFeet = null;     // swept ground-contact check
    this.lastSafeX = null;     // pit-recovery point (last place we had footing)
    this._grounded = false;    // scene.resolveGround owns (levels: any surface)
    this.invuln = 0;           // frames of hit-invulnerability (pit recovery)
    this.weapon = null;        // 'pistol' (gunner mook; AI + render + bullet owner)
    this.muzzleT = 0;          // muzzle-flash frames (set on fire, ticked on sim step)
    this.firedShot = false;    // one bullet per shoot swing
    this.wallBlockDir = 0;     // +1/-1: direction the opponent is blocking
    // Airborne pose parameter: 0 = tuck (launch), 1 = reach (land). EASED on
    // the fixed sim step toward the vy-derived target — NOT read directly
    // from vy at render time (that made the pose chase gravity's rate and
    // snap on jump-cut; the ease makes it trail ~half a beat, gradual).
    this.airT = 0.5;
    this.wasAirborne = false;
    this.airborne = false;

    // Cooldowns & timers (frames).
    this.dashCooldown = 0;
    this.dashTimer = 0;
    this.dashSustainKey = null; // dir if this dash came from a double-tap
    this.hitstun = 0;
    this.attackCooldown = 0;

    // Attack bookkeeping.
    this.currentAttack = null; // name
    this.attackFrame = 0;      // counts up from 0 across startup+active+recovery
    this.hitConfirmed = false; // one hit per attack
    // Jab chain (3-hit combo): chainStep = last chain link fired (0..3),
    // chainT = frames since that link STARTED (must be within the window to
    // advance). A lone tap leaves chainStep reset so the next tap restarts.
    this.chainStep = 0;
    this.chainT = 999;
    this.chainQueued = false;  // early-press held for the next cancel opportunity
    this.chainWindow = 32;     // frames after a link's start to press again & keep the chain
                               // (just past the 22f link cooldown: a relaxed
                               // human still links, but a deliberate pause resets)
    this._jabHeld = false;     // rising-edge detector: the 3-step input buffer must read as ONE press

    // Hitboxes (spawned fresh per attack active window).
    this.hitboxes = [];        // {x,y,w,h,...} world-space rect (left,top,w,h)
    // Bullet-guard boxes (katana): published for the WHOLE wind-up+active
    // window so blocking is timing-lenient. Deliberately NOT in hitboxes[] —
    // resolveHits never sees these, so a guard deflects steel but never cuts
    // flesh by accident.
    this.guardBoxes = [];
  }

  // Ground truth comes from the scene (levels: floors[] AND one-way
  // platforms[]; flat arena: the groundY plane). The old arcade
  // blocked.down still matches on the flat arena, but with a manual-stepped
  // world it no longer covers platforms/pits.
  get onGround() { return this._grounded; }

  // Which gait animation applies RIGHT NOW. Walk and sprint are separate
  // cycles: one blended compromise looked bad as either. Dash hold-phase is
  // always sprint; dash BURST (dashTimer>0) is its own leap pose.
  gaitMode() {
    if (this.airborne) return 'none';
    if (this.state === 'dash') return 'sprint';  // burst layers the leap on top
    if (this.state === 'run') return 'walk';
    if (this.state === 'attack') {
      const sp = this.body ? Math.abs(this.body.velocity.x) : 0;
      if (sp <= 140) return 'none';
      return sp > 320 ? 'sprint' : 'walk';   // sprinting attacks keep sprint legs
    }
    return 'none';
  }
  strideNow() {
    return this.gaitMode() === 'sprint' ? CFG.strideSprint : CFG.strideWalk;
  }
  get body() { return this.sprite.body; }
  get x() { return this.sprite.x; }
  get y() { return this.sprite.y; }

  // ---- Per-fixed-step control input ---------------------------------------
  // `input` is a plain object sampled once per step by the scene.
  update(input) {
    // Tick frame timers.
    if (this.dashCooldown > 0) this.dashCooldown--;
    if (this.attackCooldown > 0) {
      this.attackCooldown--;
      // Buffered chain continuation. THE TAX NEVER GATES A LINK (user: pop 2
      // lagged badly behind pop 1): a short link like jab1 (10 frames) ends
      // while its 22f cooldown is still burning, so a natural-speed second
      // tap arrived post-attack and waited out the whole lone-tap tax — 367ms
      // gap vs 167ms for the finisher. The string's own clock (chainWindow)
      // is the only gate once you've committed; startAttack overwrites the
      // cooldown anyway. The tax still gates the NEXT string (selectAttack).
      // CAPPED AT TWO (user: J-J-K): only step 1 auto-links to jab2; a press
      // on the second pop is dropped (the finisher is a HEAVY, chosen by the
      // player via the cancel window below — never an auto third hit).
      if (this.chainQueued && !this.currentAttack
          && !this.ai && !this.airborne && this.chainStep === 1
          && this.chainT <= this.chainWindow) {
        this.startAttack('jab2');
        return;
      }
    } else if (this.chainQueued) {
      this.chainQueued = false;   // stale (window expired / attack started elsewhere)
    }
    // Rising-edge the jab: the scene's 3-step input buffer makes ONE tap
    // read as jab=true for 3 consecutive sim steps, which would auto-advance
    // the chain by itself. A chain press = key newly down.
    const jabPressed = !!input.jab && !this._jabHeld;
    this._jabHeld = !!input.jab;
    if (this.chainT < 900) this.chainT++;   // frames since last chain link started
    if (this.invuln > 0) this.invuln--;
    if (this.muzzleT > 0) this.muzzleT--;

    if (this.hitstun > 0) {
      this.hitstun--;
      this.state = 'hurt';
      // During hitstun the player cannot act; knockback velocity carries.
      // Meteor: the spike's landing pops a hurt bounce + extra stun, which
      // is the juggle-extension window.
      if (this.meteorPending && this.onGround) {
        this.meteorPending = false;
        this.body.setVelocityY(-200);
        this.hitstun = Math.max(this.hitstun, 16);
        this._snapNext = true;
      }
      if (this.hitstun === 0 && this.onGround) {
        this.state = 'idle';
        this.meteorPending = false;
      }
      this.physicsStep(false);
      return;
    }

    // Air/ground bookkeeping.
    this.airborne = !this.onGround;

    // Ease the airborne pose parameter on the FIXED step (never from render:
    // this keeps the ease identical across refresh rates).
    if (this.airborne) {
      const vj = CFG.jump.velocity;
      const vy = this.body.velocity.y;
      const target = Math.max(0, Math.min(1, (vy - vj) / (-2 * vj)));
      if (!this.wasAirborne) this.airT = target;  // fresh launch: no stale drift
      else this.airT += (target - this.airT) * 0.10;  // ~10-frame settle: gradual
    }
    this.wasAirborne = this.airborne;

    // Body-block contact (set by scene.separateBodies; consumed here so it
    // survives until the next sim step's update). While wallContact: no
    // striding, no driving into the wall, and ground state reads idle — a
    // fighter pressing on an opponent STOPS, they never run in place.
    // wallContact is refreshed every sim step by scene.separateBodies (sticky
    // touch test), so we READ it here rather than consume it.
    const wall = this.wallContact && !this.airborne;
    const wallDir = this.wallBlockDir;

    // Advance gait by ACTUAL distance travelled — runs during attacks and
    // dash-exit slides too (legs keep cycling whenever the feet are moving).
    // While wallContact (body-blocked by the opponent) the stride FREEZES:
    // the animation is a function of TRUE ground speed, so a stopped fighter
    // stands in a planted pose instead of moonwalk-trotting in place.
    // Moving OPPOSITE to facing (knockback recovery slides, pushed-back
    // duels) plays the same cycle BACKWARDS: the phase runs negative, and a
    // phase-reversed planted gait is a physically correct backpedal (the
    // planted foot sweeps forward relative to the hip exactly as the body
    // slides backward, so contact still holds).
    if (!this.airborne && !wall && Math.abs(this.body.velocity.x) > 20) {
      const alongFacing = Math.sign(this.body.velocity.x) === this.facing ? 1 : -1;
      this.cyclePhase = (this.cyclePhase
        + alongFacing * Math.abs(this.body.velocity.x) * STEP / this.strideNow() + 1) % 1;
    }

    // Attack state dominates movement.
    if (this.state === 'attack') {
      const cur = this.currentAttack && CFG.attacks[this.currentAttack];
      // HEAVY CANCEL (user: J-J-K): from mid-active of pop 2, any heavy —
      // K plain, or W+K / S+K variants — interrupts the string. The finisher
      // is the PLAYER's choice: heavy / cartwheel / hammerfist all become the
      // combo's payoff, and momentum (lunge) carries into the cancel.
      if (cur && cur.cancelFrom != null && !this.ai && !this.airborne
          && this.attackFrame >= cur.cancelFrom && input.heavy) {
        const mv = this.selectAttack(input);
        if (mv && mv !== 'shoot') { this.startAttack(mv); return; }
      }
      // CHAIN CANCEL (jab1 only): the recovery of pop 1 cancels into pop 2
      // when J is pressed again (buffered early presses too). CAPPED AT TWO
      // (user): there is no third link — presses on pop 2 do nothing; K
      // cancels out above. Players only: AI pulses inp.jab for its free
      // pokes and must never fall into the chain (mob balance stays on the
      // old 'jab' numbers).
      if (cur && cur.chain && !this.ai && !this.airborne && (jabPressed || this.chainQueued)
          && this.chainStep === 1) {
        // RHYTHM (user: tight pop-pop): pop 2 unlocks at jab1.linkFrom —
        // early, so even a mash lands the double tight.
        const unlock = cur.linkFrom != null ? cur.linkFrom : (cur.startup + cur.active);
        if (this.attackFrame < unlock) {
          if (jabPressed) this.chainQueued = true;   // pressed too early: hold it
        } else if (this.chainT <= this.chainWindow) {
          this.startAttack('jab2');
          return;
        }
      }
      this.tickAttack();
      // No lockX: existing momentum carries through the attack.
      return;
    }

    if (this.state === 'dash') {
      this.tickDash(input);
    }

    // ---- Attack inputs (take priority over movement) ----
    if (this.attackCooldown === 0 && (this.state === 'idle' || this.state === 'run'
        || this.state === 'jump' || this.state === 'fall' || this.state === 'dash')) {
      const mv = this.selectAttack(input);
      if (mv && this.canStartAttack()) { this.startAttack(mv); return; }
    }
    // Chain press landing on the tax window (idle, cooldown ticking): buffer
    // it so the string resumes the frame the cooldown lifts. CAPPED: only the
    // pop1 -> pop2 link buffers; presses after pop 2 open a fresh string.
    if (jabPressed && !this.currentAttack && !this.ai && this.attackCooldown > 0
        && this.chainStep === 1 && this.chainT <= this.chainWindow) {
      this.chainQueued = true;
    }
    // HEAVY CANCEL, post-pop-2 (J-J-K at human speed): K landing while pop 2
    // still sits inside its cancel window (even after the attack ended, in
    // the tax) fires the chosen heavy NOW — the string never waits out the
    // lone-tap cooldown.
    if (!this.currentAttack && !this.ai && !this.airborne && input.heavy
        && this.chainStep === 2 && this.chainT <= this.chainWindow) {
      const mv = this.selectAttack(input);
      if (mv && mv !== 'shoot') { this.startAttack(mv); return; }
    }

    // ---- Dash (ground only) ----
    if (input.dash && this.dashCooldown === 0 && this.state !== 'dash'
        && this.onGround && (this.state === 'idle' || this.state === 'run')) {
      // Dash in the direction being held, else face.
      const dir = input.left ? -1 : (input.right ? 1 : this.facing);
      this.facing = dir;
      this.state = 'dash';
      // No snap: the entry pose eases in over a frame or two (fast rate in
      // blendPose) — sells the push-off without the leap losing its punch.
      this.dashTimer = CFG.dash.burstFrames;  // burst phase, then hold-to-sprint
      // Double-tap dashes sustain on the direction key; Shift dashes on Shift.
      this.dashSustainKey = (input.dashSrc === 'tap') ? dir : null;
      this.body.setVelocityX(dir * CFG.dash.burstSpeed);
      this.body.setVelocityY(0);
    }

    // ---- Horizontal movement (if not dashing) ----
    if (this.state !== 'dash') {
      const isRun = this.state === 'run';
      const cfg = this.airborne ? CFG.air : CFG.run;
      let drive = 0;
      if (input.left)  { drive = -1; if (!this.airborne) this.facing = -1; }
      if (input.right) { drive = +1; if (!this.airborne) this.facing = +1; }

      // Pressing into the body-block wall: no accel (this is the moonwalk-
      // prevention; true velocity stays pinned at 0 toward the opponent).
      if (wall && drive === wallDir) { drive = 0; this.body.setVelocityX(0); }

      if (drive !== 0) {
        const v = this.body.velocity.x;
        // If we're ALREADY faster than max in the held direction (dash exit,
        // dash-jump airspeed), don't engine-brake back to max — just coast.
        const coasting = Math.sign(v) === drive && Math.abs(v) > cfg.maxSpeed;
        if (!coasting) {
          const target = drive * cfg.maxSpeed;
          // Turning (input opposes current motion) uses the slower turnDecel rate,
          // so reversing direction takes ~2x as long as speeding up.
          const turning = !this.airborne && drive * v < -5;
          const rate = turning ? CFG.run.turnDecel : cfg.accel;
          this.body.setVelocityX(this.approach(v, target, rate * STEP));
        }
      } else if (!this.airborne) {
        // Ground friction.
        this.body.setVelocityX(this.approach(this.body.velocity.x, 0, CFG.run.friction * STEP));
      }

      if (!this.airborne) {
        if (Math.abs(this.body.velocity.x) > 20 && !wall) this.state = 'run';
        else this.state = 'idle';
      } else {
        this.state = this.body.velocity.y < 0 ? 'jump' : 'fall';
      }
    }

    // ---- Jump (variable height) ----
    if (input.jump && !this.airborne) {
      if (this.state === 'dash') {
        // Dash-jump: keep horizontal velocity exactly as-is; only arm cooldown.
        this.dashCooldown = CFG.dash.cooldown;
        this.dashSustainKey = null;
      }
      this.body.setVelocityY(CFG.jump.velocity);
      this.state = 'jump';
    }
    if (this.body.velocity.y < 0 && !input.jumpHeld) {
      // Jump cut: release early for a shorter hop.
      this.body.setVelocityY(this.body.velocity.y * CFG.jump.cutMultiplier);
    }

    if (this.airborne && this.state !== 'dash') {
      this.state = this.body.velocity.y < -10 ? 'jump' : 'fall';
    }

    this.animTime += STEP;
    this.physicsStep(false);
  }

  physicsStep(lockX) {
    if (lockX) this.body.setVelocityX(0);
  }

  approach(cur, target, delta) {
    if (cur < target) return Math.min(cur + delta, target);
    if (cur > target) return Math.max(cur - delta, target);
    return cur;
  }

  // ---- Attacks ----
  canStartAttack() { return !this.currentAttack; }

  // Context picker: two attack buttons x stance = whole moveset (Smash/Kirby
  // grammar). W/S are attack-DIRECTION modifiers, not movement (jump = SPACE).
  //   grounded J/K          -> jab / heavy
  //   grounded W+J/K        -> uppercut / cartwheel (launchers; work from run too)
  //   grounded S+J/K        -> sweep / hammerfist
  //   air J                 -> airjab   (small, keeps float)
  //   air K (or W+K)        -> axekick  (forward-down heel chop, meteor on grounded)
  //   air W+J               -> uppercut (mid-air pop)
  //   during dash-burst J/K -> dashatk  (shoulder check, speed-scaled slam)
  selectAttack(input) {
    // Gunner fire (AI sets input.shoot; stays off the keyboard for players
    // until guns are a player weapon). Bypasses the two-button grammar.
    if (input.shoot) return 'shoot';
    const H = !!input.heavy, L = !!input.jab;
    if (!H && !L) return null;
    if (this.state === 'dash' && this.dashTimer > 0) return 'dashatk';
    // KATANA starter (user spec): NEUTRAL J / K become slashes when grounded
    // with no W/S modifier. Everything else (air, W/S contexts, dash) falls
    // through to the shared body grammar — a starter moveset, not a full one.
    if (this.weapon === 'katana' && !this.airborne && !input.up && !input.down)
      return H ? 'katHeavy' : 'katLight';
    if (this.airborne) {
      // W is the ONLY up-indicator (no jump-timing guesswork — that was the
      // untimable "rising" heuristic). air K always = axe kick.
      if (input.up) return H ? 'cartwheel' : 'uppercut';
      if (H) return 'axekick';
      return 'airjab';
    }
    if (input.up) return H ? 'cartwheel' : 'uppercut';   // up+attack = launcher, no jump needed
    if (input.down) return H ? 'hammerfist' : 'sweep';   // (also works from run)
    if (H) return 'heavy';
    if (this.ai) return 'jab';              // mob free-poke: old numbers, no chain
    // Player grounded plain jab: a live pop 1 in window links to pop 2, else
    // open a FRESH string. CAPPED AT TWO (user): there is no third auto-hit —
    // the finisher is a HEAVY the player chooses (cancel window on pop 2).
    if (this.chainStep === 1 && this.chainT <= this.chainWindow)
      return 'jab2';
    return 'jab1';
  }

  startAttack(name) {
    const atk = CFG.attacks[name];
    // Chain bookkeeping: links advance chainStep (1/2/3) and refresh the
    // window clock; ANY non-chain attack (heavy, launcher, shot...) resets
    // the chain — committing elsewhere forfeits the string.
    if (atk.chain) {
      this.chainStep = (name === 'jab1') ? 1 : (name === 'jab2') ? 2 : 0;
      this.chainT = 0;
    } else {
      this.chainStep = 0;
    }
    this.chainQueued = false;
    this.currentAttack = name;
    this.attackFrame = 0;
    this.hitConfirmed = false;
    this.firedShot = false;   // one bullet per shoot swing (armed here, set on fire)
    // Snap the anticipation pose (punches must NOT smear in), but let the
    // retraction at the END blend out smoothly back to guard/run.
    this._snapNext = true;
    this._snapImpact = atk.startup + 1; // snap on the first EXTENSION frame
    this.state = 'attack';
    this.attackCooldown = atk.cooldown;
    // Momentum carries: horizontal velocity is NOT touched here.
    // Stomp sells the spike with an actual downward commitment.
    if (atk.meteor && this.airborne) {
      this.body.setVelocityY(Math.max(this.body.velocity.y, 380));
    }
  }

  tickDash(input) {
    // Left the ground mid-dash (dash-jump or walked off a ledge): keep ALL
    // horizontal momentum — only arm the cooldown and hand off to jump/fall.
    if (!this.onGround) {
      this.dashCooldown = CFG.dash.cooldown;
      this.state = this.body.velocity.y < -10 ? 'jump' : 'fall';
      return;
    }
    if (this.dashTimer > 0) {
      // Burst phase: fixed few frames of pure speed, regardless of hold.
      this.dashTimer--;
      this.body.setVelocityX(this.facing * CFG.dash.burstSpeed);
    } else if (input && (input.dashHeld
        || (this.dashSustainKey !== null && input.heldDir === this.dashSustainKey))) {
      // Sprint phase: hold the dash key — or, for double-tap dashes, keep the
      // direction key held — to sustain (slower than the burst).
      this.body.setVelocityX(this.facing * CFG.dash.sprintSpeed);
    } else {
      this.endDash();
    }
  }

  endDash() {
    // Clamping (not snapping) above-walk speed down keeps release predictable.
    const v = this.body.velocity.x, cap = CFG.run.maxSpeed;
    if (Math.abs(v) > cap) this.body.setVelocityX(Math.sign(v) * cap);
    this.state = 'idle';
    this.dashCooldown = CFG.dash.cooldown;
  }

  tickAttack() {
    const atk = CFG.attacks[this.currentAttack];
    this.attackFrame++;
    if (this.attackFrame === this._snapImpact) this._snapNext = true;
    const activeStart = atk.startup;
    const activeEnd = atk.startup + atk.active;

    // Publish a hitbox only during active frames (and only until it lands).
    // Multi-hit (hitFrames = [f1, f2]): each frame opens a fresh 2-frame
    // window with its own hit-landed flag — the cartwheel's tick-then-pop.
    this.hitboxes.length = 0;
    // Sword guard: the blade is "up" for the entire wind-up AND active
    // window, so a katana blocks bullets on reaction (frames 0..active), not
    // only on the 3 damaging active frames. Separate array: no damage.
    this.guardBoxes.length = 0;
    if (atk.guard && this.attackFrame >= 1 && this.attackFrame <= activeEnd)
      this.guardBoxes.push(this.attackWorldBox(atk, atk.guard));
    // Gun: the aim COMMITS at atk.aimLock (a few frames before the fire
    // frame) and never tracks again — moving off the line genuinely dodges.
    // The committed vector lives on the fighter so renderSights can draw the
    // laser sight, and the fire frame just spends it.
    if (atk.fire) {
      if (this.attackFrame === (atk.aimLock || atk.startup) && !this.aimVec) {
        let vx2 = this.facing * atk.fire.speed, vy = 0;
        const t = this.ai && this.ai.gunner ? (this.ai.target || null) : null;
        if (t && !t.dead) {
          const dx = t.x - this.x, dy = (t.y - 8) - (this.y + atk.fire.y);
          if (dx * this.facing > 0) {                     // only aim where we face
            const dist = Math.hypot(dx, dy);
            const sp = atk.fire.speed;
            vx2 = (dx / dist) * sp;
            vy = (dy / dist) * sp;
          }
        }
        this.aimVec = { vx: vx2, vy };
      }
      // Fire on the first active frame (muzzle-flash frame) with the LOCKED
      // vector. A shot that never locked (edge cases) re-aims now.
      if (this.attackFrame === atk.startup + 1 && !this.firedShot) {
        this.firedShot = true;
        this.muzzleT = 4;   // flash frames (render-side)
        const a = this.aimVec || { vx: this.facing * atk.fire.speed, vy: 0 };
        this.aimVec = null;   // spent
        this.scene.spawnBullet({
          x: this.x + this.facing * 46, y: this.y + atk.fire.y,
          vx: a.vx, vy: a.vy,
          damage: atk.damage,
          knock: { x: atk.knock.x, y: atk.knock.y, hitstun: atk.knock.hitstun },
          owner: this,
        });
      }
    }
    if (this.currentAttack !== 'shoot') this.firedShot = false;
    if (this.currentAttack !== 'shoot') this.aimVec = null;   // never leaked across attacks
    if (atk.hitFrames) {
      for (const hf of atk.hitFrames) {
        if (this.attackFrame === hf) this.hitConfirmed = false;  // new window
        if (this.attackFrame >= hf && this.attackFrame < hf + 2 && !this.hitConfirmed) {
          this.hitboxes.push(this.attackWorldBox(atk));
        }
      }
    } else if (this.attackFrame > activeStart && this.attackFrame <= activeEnd && !this.hitConfirmed) {
      this.hitboxes.push(this.attackWorldBox(atk));
    }
    if (this.attackFrame >= activeStart + atk.active + atk.recovery) {
      this.currentAttack = null;
      this.hitboxes.length = 0;
      this.guardBoxes.length = 0;
      this.state = this.airborne ? 'fall' : 'idle';
    }
    // Slight forward step on the ground during startup+active of lunging
    // attacks (heavy; chain links step IN so the string stays connected —
    // light knockback alone lets the target slide out of box range by link 2).
    if (atk.lunge && !this.airborne
        && this.attackFrame > atk.startup - 3 && this.attackFrame <= activeEnd) {
      // Lunge drive is ADDED to (capped by) existing momentum, never overwrites it.
      this.body.setVelocityX(this.approach(this.body.velocity.x,
        this.facing * Math.max(Math.abs(this.body.velocity.x), 170), atk.lunge * STEP));
    }
  }

  attackWorldBox(atk, boxOverride) {
    const bx = boxOverride || atk.box;
    const cx = this.x + this.facing * bx.x;
    const cy = this.y + bx.y;
    // box.x is "distance from center"; convert to a left/top rect.
    return {
      x: this.facing === 1 ? cx : cx - bx.w,
      y: cy - bx.h / 2,
      w: bx.w,
      h: bx.h,
      damage: atk.damage,
      // knockScale: attacker speed feeds knockback (dash attack at 560
      // slams mooks clean across the arena — momentum-through-attacks).
      knock: atk.knockScale
        ? { x: atk.knock.x + Math.abs(this.body.velocity.x) * 0.8,
            y: atk.knock.y, hitstun: atk.knock.hitstun }
        : atk.knock,
      meteor: !!atk.meteor,
    };
  }

  // KO: sim skips via dead flag; the ragdoll object drives the corpse until
  // it fades and despawns.
  // Fake physics (no engine — Star Fetchers/YOMI approach): the corpse's
  // arcade BODY does the ballistic flight (we already pay for it), and each
  // joint is a damped pendulum toward its "at rest" angle. Joints carry
  // angular velocity so a launch WHIPS the limbs; on impact stiffer ground
  // springs slam them toward splayed sprawl. Zero extra bodies/joints, a
  // handful of arithmetic ops per corpse per step, and ZERO once settled —
  // the frozen "still image" phase integrates nothing at all.
  ko(hb) {
    this.dead = true;
    this.currentAttack = null;
    this.hitboxes.length = 0;
    this.guardBoxes.length = 0;   // a corpse blocks nothing
    this.state = 'hurt';
    if (this.ai) this.aiIn = {};   // brain hands off permanently
    const K = CFG.ragdoll;
    const v = this.body.velocity;
    const rnd = (a) => (Math.random() * 2 - 1) * a;
    // INHERIT THE BLOW (user: uppercut KOs lost all their vy — this pop used
    // to OVERWRITE knockback velocity). Add liveliness ON TOP of the killing
    // blow's launch, capped to the jump-speed scale so nothing leaves the sky.
    if (this.onGround) v.y = Math.max(CFG.jump.velocity, Math.min(v.y, 0) - (140 + Math.random() * 90));
    // Remember the LAUNCH vertical velocity — ragStep's lie-down lean reads it
    // so a corpse killed going UP (uppercut/cartwheel) topples backward and one
    // killed going DOWN (axe kick/meteor) crumples forward (user: "different for
    // each move"). Captured before the body is disabled.
    const vy0 = v.y;
    // Hand physics to ragStep: with the arcade body DISABLED, world.step
    // skips it entirely — ragStep's manual integration is the only mover
    // (no gravity double-apply) and settled corpses touch zero physics.
    this.body.enable = false;
    // No floor bounce (user: "corpses bounce before settling"): landings stick.
    // Live-flailer cap: if too many corpses are mid-air, force-freeze the
    // oldest (settled corpses cost nothing, so only the flailing cost).
    const live = this.scene.fighters.filter((f) => f.ragdoll && !f.ragdoll.settled && !f.gone);
    while (live.length >= K.maxLive) live.shift().forceFreeze();
    // Joint angles: torso 0 = upright (topples to ±90 = flat); limbs 0 = hang
    // straight down. Angular velocities seeded from the knock direction so
    // the corpse's limbs trail the blow.
    // LIE-DOWN DIRECTION DECIDED ONCE AT DEATH (user: head landed one way then
    // flipped). headWorld = the world side the head ends on: killed going UP
    // (launch vy<0) head trails the travel -> lands on the back; killed going
    // DOWN (vy>0) head LEADS -> faceplant; flat kills random. The airborne
    // flail target AND the lie-down blend target both read THIS value (and
    // launch-time v.x, immune to later wall bounces), so the head never has
    // to swing 180deg across the landing blend.
    const lean = Math.max(-1, Math.min(1, (vy0 || 0) / 640));
    const dirX0 = Math.sign(v.x || -this.facing) || 1;
    // Some land the OTHER way (user): 25% chance to toss-over — an uppercut
    // victim that somersaults onto their face, a spiked mook that bounces
    // onto its back. Minority so the finisher still usually reads right;
    // still decided ONCE at death (never re-flips mid-blend).
    const flip = Math.random() < 0.25;
    const headWorld = lean > 0.15 ? (flip ? -dirX0 : dirX0)
                    : lean < -0.15 ? (flip ? dirX0 : -dirX0)
                    : (Math.random() < 0.5 ? dirX0 : -dirX0);
    const fling = this.facing * (2 + Math.random() * 3);
    this.ragdoll = {
      t: 0, frames: 0, alpha: 1, settled: false, freeze: null, restLeft: 0, gnd: false,
      hipY: this.sprite.y + 10,   // drawn pivot; ragStep owns it (flight rides sprite, blend sinks it)
      sprawl: null, sprawlDone: false, vy0, lean, headWorld, flip,
      torso: { th: this.facing * headWorld * (0.25 + Math.random() * 0.35), thv: fling },
      legA:  { th: rnd(0.5), thv: v.x * 0.004 + rnd(7), bend: 0 },
      legB:  { th: rnd(0.5), thv: v.x * 0.004 + rnd(7), bend: 0 },
      armA:  { th: rnd(0.7), thv: v.x * 0.005 + rnd(9) },
      armB:  { th: rnd(0.7), thv: v.x * 0.005 + rnd(9) },
    };
    // Meteor spikes: skip the pop, slam straight down (default faceplant,
    // still honoring the death-time toss-over flip).
    if (hb && hb.meteor) {
      v.y = Math.max(v.y, 420);
      const rd0 = this.ragdoll;
      const d = Math.sign(v.x || -this.facing) || 1;
      rd0.vy0 = v.y; rd0.lean = 1;
      rd0.headWorld = rd0.flip ? -d : d;
      rd0.torso.th = this.facing * rd0.headWorld * 0.4;
      rd0.torso.thv = this.facing * 6;
    }
  }

  // Fake-physics ragdoll (no physics engine — Star Fetchers/YOMI approach):
  // the corpse's arcade BODY does the ballistic flight (we already pay for
  // it), and each joint is a damped pendulum toward its "at rest" angle.
  // Joints carry angular velocity so a launch WHIPS the limbs; on impact the
  // stiffer ground springs slam them toward splayed-out sprawl. Zero extra
  // bodies, zero joint constraints, ~6 trig calls per corpse per sim step.
  ragStep(dt) {
    const rd = this.ragdoll, K = CFG.ragdoll;
    // FREEZE = zero physics: the frozen "still image" only ticks a fade
    // clock. (This is why thousands of corpses cost nothing until they fade.)
    if (rd.settled) {
      rd.restLeft--;
      if (rd.restLeft <= K.fadeFrames) rd.alpha = Math.max(0, rd.restLeft / K.fadeFrames);
      if (rd.restLeft <= 0) this.gone = true;
      return;
    }
    const v = this.body.velocity;
    rd.t += dt;
    rd.frames++;

    // Ballistic body — the ONLY integrator now: ko() disabled the arcade
    // body, so arcade's world.step skips it (otherwise gravity double-applies).
    // Near-zero air drag: the corpse keeps the blow's momentum (user).
    v.y += CFG.gravity * dt;
    v.x *= (1 - K.airDrag * dt);
    this.sprite.x += v.x * dt;
    this.sprite.y += v.y * dt;
    // World bounds: walls catch flying bodies (ragdoll keeps wall-pin energy).
    const hw = CFG.body.width / 2;
    if (this.sprite.x < hw) { this.sprite.x = hw; v.x = Math.abs(v.x) * 0.35; }
    else if (this.sprite.x > this.scene.levelWidth - hw) {
      this.sprite.x = this.scene.levelWidth - hw; v.x = -Math.abs(v.x) * 0.35;
    }

    // Floor: scene-owned (levels.js floors[]/pits change it per-x — see
    // FightScene.ragdollGround; flat arena = groundY as before).
    // (ragdoll-local ground flag: `onGround` reads arcade blocked.down,
    // which never updates while the body is disabled.)
    const centerY = this._ragFloor;
    const onGnd = this._ragGnd === true;
    if (onGnd && centerY !== null && centerY !== undefined) {
      this.sprite.y = centerY;
      // LIE-DOWN: first ground contact starts a SHORT pose blend (user:
      // "over a couple frames", not instant, not smoothed-with-springs).
      // 4-frame angle lerp into an explicit lying pose (torso flat, head on
      // the knock side, legs extended trailing, arms flopped). No springs
      // involved — scripted blend of angles only.
        if (!rd.sprawl && !rd.sprawlDone) {
          const whip = Math.min(Math.max(v.y, 0), 600) * 0.0022 * (Math.sign(v.x || this.facing) || 1);
          const f = this.facing;
          // LIE target from the DEATH-TIME headWorld/lean (ko) — recomputing
          // from live velocity here let wall bounces flip the head mid-blend
          // (user). Randomness per corpse: arms reach out sometimes, a leg
          // bends up occasionally. Nothing fancy — just not all-same.
          const lean = rd.lean, hw = rd.headWorld;
          const over = 1.28 + Math.abs(lean) * 0.30 + Math.random() * 0.08;
          // Per-corpse variation (user): arms reach OUT sometimes, a leg
          // BENDS (knee up) occasionally. Angles mirrored by facing at use.
          const armT = () => (Math.random() < 0.35
            ? (Math.random() < 0.5 ? -hw : hw) * (1.25 + Math.random() * 0.45)   // reaching out
            : (Math.random() < 0.5 ? 1 : -1) * (0.95 + Math.random() * 0.55));
          const bendT = () => (Math.random() < 0.35
            ? (Math.random() < 0.5 ? -1 : 1) * (0.7 + Math.random() * 0.5)
            : 0);
          rd.sprawl = {
            t: 0, frames: K.sprawlFrames,
            from: { torso: rd.torso.th, legA: rd.legA.th, legB: rd.legB.th, armA: rd.armA.th, armB: rd.armB.th,
                    bendA: rd.legA.bend, bendB: rd.legB.bend },
            to: {
              torso: (hw * over + whip * 0.2) * f,
              legA: (-hw * (1.22 + Math.random() * 0.25)) * f,
              legB: (-hw * (1.05 + Math.random() * 0.35)) * f,
              armA: (lean < -0.15 && Math.random() < 0.5 ? hw * (1.25 + Math.random() * 0.45) : armT()) * f,
              armB: (lean > 0.15 && Math.random() < 0.5 ? hw * (1.25 + Math.random() * 0.45) : armT()) * f,
              bendA: bendT() * f, bendB: bendT() * f,
            },
            hipFrom: rd.hipY, hipTo: (centerY !== null && centerY !== undefined ? centerY : this.scene.groundY - CFG.body.height / 2) + CFG.body.height / 2 - 14,
          };
          rd.torso.thv = 0;
          for (const j of [rd.legA, rd.legB, rd.armA, rd.armB]) j.thv = 0;
        }
        if (v.y > 0) v.y = 0;                           // landings STICK (user: no bounce)
        v.x *= (1 - K.groundFriction * dt);             // slide, then stop fast
      } else if (!rd.sprawl) {
      // Airborne: the drawn hip rides the sprite (the OLD tilt-driven sink
      // pinned flying corpses to the floor line — that's why uppercut KOs
      // looked like they barely left the ground; they fly ~100px now).
      rd.hipY = this.sprite.y + 10;
    }

    // Advance the lie-down blend (grounded frames only).
    if (rd.sprawl && onGnd) {
      const s = rd.sprawl;
      s.t++;
      const u = Math.min(1, s.t / s.frames);
      const lerp = (a, b) => a + (b - a) * u;
      rd.torso.th = lerp(s.from.torso, s.to.torso);
      rd.legA.th = lerp(s.from.legA, s.to.legA);
      rd.legB.th = lerp(s.from.legB, s.to.legB);
      rd.armA.th = lerp(s.from.armA, s.to.armA);
      rd.armB.th = lerp(s.from.armB, s.to.armB);
      rd.legA.bend = lerp(s.from.bendA, s.to.bendA);
      rd.legB.bend = lerp(s.from.bendB, s.to.bendB);
      rd.hipY = lerp(s.hipFrom, s.hipTo);
      if (u >= 1) { rd.sprawl = null; rd.sprawlDone = true; }
    }

    // Joint springs: airborne flail ONLY (limbs whip underdamped on the way
    // down toward the death-decided topple); on the ground the lie-down
    // blend owns the angles.
    const grounded = onGnd && v.y === 0;
    rd.gnd = grounded;
    if (!grounded && !rd.sprawl) {
      const set = (j, rest) => {
        j.thv += (-K.airK * (j.th - rest) - K.airC * j.thv) * dt;
        j.th += j.thv * dt;
      };
      set(rd.torso, rd.headWorld * 0.8 * this.facing);
      set(rd.legA, 0); set(rd.legB, 0); set(rd.armA, 0); set(rd.armB, 0);
    }

    // Settle once the blend finished and the corpse stopped sliding ->
    // FREEZE (still image) -> fade -> despawn (fade clock in the early-return).
    if ((grounded && rd.sprawlDone && Math.abs(v.x) < 30) || rd.frames > K.flailMaxFrames) this.forceFreeze();
  }

  // Joint-angle FK: skeleton points straight FROM the spring state (the
  // ragdoll IS the pose generator — no computePose/blend/IK involved).
  // Rendered every flail frame and captured ONCE at freeze time.
  _ragPoints() {
    const rd = this.ragdoll, f = this.facing;
    // Hip height is OWNED by ragStep (rd.hipY): rides the sprite in flight
    // (so uppercut KOs visibly FLY — the old tilt-driven sink pinned the
    // drawn skeleton to the floor line while the body was airborne) and
    // lerps to floor level during the lie-down blend.
    const hip = { x: this.sprite.x, y: (rd.hipY != null ? rd.hipY : this.sprite.y + 10) };
    const T = rd.torso.th;
    // Torso up-vector rotated by topple angle T (T=0 upright, ±90deg flat).
    const ux = Math.sin(T) * f, uy = -Math.cos(T);
    const neck = { x: hip.x + ux * 26, y: hip.y + uy * 26 };
    const head = { x: neck.x + ux * 14, y: neck.y + uy * 14 };
    // Pendulum segments: angle measured from straight-down, mirrored by facing.
    const seg = (ox, oy, ang, len) => ({ x: ox + Math.sin(ang) * len, y: oy + Math.cos(ang) * len });
    const elbowA = seg(neck.x, neck.y, rd.armA.th * f, 19);
    const handA = seg(elbowA.x, elbowA.y, rd.armA.th * 1.35 * f, 18);
    const elbowB = seg(neck.x, neck.y, rd.armB.th * f, 19);
    const handB = seg(elbowB.x, elbowB.y, rd.armB.th * 1.35 * f, 18);
    const kneeA = seg(hip.x, hip.y, rd.legA.th * f, 24);
    const footA = seg(kneeA.x, kneeA.y, rd.legA.th * 0.7 * f + (rd.legA.bend || 0), 24);
    const kneeB = seg(hip.x, hip.y, rd.legB.th * f, 24);
    const footB = seg(kneeB.x, kneeB.y, rd.legB.th * 0.7 * f + (rd.legB.bend || 0), 24);
    // FLOOR CLAMP (user: legs sank through the ground): FK has no floor
    // constraint, so sprawl angles can drive feet/hands below the floor line.
    // Pin contact points at the floor; segment lengths shorten a hair when
    // clamped — invisible on stick lines, and better than subterranean limbs.
    const floor = (this._ragFloor == null) ? this.scene.groundY
                    : this._ragFloor + CFG.body.height / 2;   // slab top (platform or groundY)
    for (const p of [kneeA, footA, kneeB, footB, elbowA, handA, elbowB, handB]) {
      if (p.y > floor) p.y = floor;
    }
    if (head.y > floor - 12) head.y = floor - 12;   // head circle rests ON floor
    return { head, neck, hip, elbowA, handA, elbowB, handB, kneeA, footA, kneeB, footB };
  }

  forceFreeze() {
    const rd = this.ragdoll;
    rd.settled = true;
    rd.freeze = this._ragPoints();   // snapshot of the sprawl, not the death pose
    rd.restLeft = CFG.ragdoll.restFrames;
  }

  // Draw the corpse. Settled: replay the frozen snapshot (no pose compute at
  // all). Flailing: FK from the live joint angles.
  renderRagdoll() {
    const rd = this.ragdoll;
    if (!rd) return;
    const p = (rd.settled && rd.freeze) ? rd.freeze : this._ragPoints();
    const g = this.gfx;
    g.clear();
    g.lineStyle(3.5, this.color, rd.alpha);
    g.strokeCircle(p.head.x, p.head.y, 12);
    g.lineBetween(p.neck.x, p.neck.y, p.hip.x, p.hip.y);
    g.lineBetween(p.neck.x, p.neck.y, p.elbowA.x, p.elbowA.y);
    g.lineBetween(p.elbowA.x, p.elbowA.y, p.handA.x, p.handA.y);
    g.lineBetween(p.neck.x, p.neck.y, p.elbowB.x, p.elbowB.y);
    g.lineBetween(p.elbowB.x, p.elbowB.y, p.handB.x, p.handB.y);
    g.lineBetween(p.hip.x, p.hip.y, p.kneeA.x, p.kneeA.y);
    g.lineBetween(p.kneeA.x, p.kneeA.y, p.footA.x, p.footA.y);
    g.lineBetween(p.hip.x, p.hip.y, p.kneeB.x, p.kneeB.y);
    g.lineBetween(p.kneeB.x, p.kneeB.y, p.footB.x, p.footB.y);
  }

  // Called by the scene when one of this fighter's hitboxes overlaps an
  // opponent's hurtbox.
  takeHit(hb, fromFacing) {
    this._snapNext = true;  // hurt recoil must read instantly
    // Interrupt a dash BEFORE knockback is applied (endDash clamps speed).
    if (this.state === 'dash') this.endDash();
    this.health = Math.max(0, this.health - hb.damage);
    this.hitstun = hb.knock.hitstun;
    this.facing = -fromFacing; // face the attacker
    this.body.setVelocityX(fromFacing * hb.knock.x);
    if (this.onGround) this.body.setVelocityY(hb.knock.y);
    this.currentAttack = null;
    this.hitboxes.length = 0;
    this.guardBoxes.length = 0;
    this.chainStep = 0;       // getting hit forfeits the jab string
    this.aimVec = null;       // a shot interrupted after its aim lock dies with it
    this.state = 'hurt';
    // Meteor spike: slam down, then a bounce + scramble delay on landing.
    if (hb.meteor) this.meteorPending = true;
    // KO AFTER knockback lands — the ragdoll inherits the corpse's velocity.
    if (this.health === 0 && !this.dead) this.ko(hb);   // mooks KO; players too (duel KO later)
  }

  // ---- Rendering ----------------------------------------------------------
  // Katana wrist angle: fully ANIMATED keyframe curve (user: the lag-blend
  // "carried posture" looked weird attacking/running/walking — animate the
  // angle directly). Facing-space radians (0 = forward, + = down). Attacks
  // get a proper timeline (sheath/draw/cut/settle — recovery ANIMATES back
  // to guard instead of snapping to a static posture), walk/sprint sway the
  // blade with the gait cycle, render() applies a light smoothing only to
  // de-pop state transitions (render-only; combat never sees this).
  bladeAngleTarget(foreAng) {
    const atk = this.currentAttack && CFG.attacks[this.currentAttack];
    if (this.state === 'attack' && atk && (atk.pose === 'slashL' || atk.pose === 'slashH')) {
      const light = atk.pose === 'slashL';
      const fr = this.attackFrame;
      const su = atk.startup, ac = atk.active, rec = atk.recovery;
      const ease = (t) => t * t * (3 - 2 * t);            // smoothstep
      if (light) {
        if (fr <= su) {
          const k = ease(Math.min(1, fr / su));
          return -0.12 + (1.15 + 0.12) * k;               // drop hand+blade back-low (coil)
        }
        if (fr <= su + ac) {
          const k = ease((fr - su) / Math.max(1, ac));
          return 1.15 + (-0.15 - 1.15) * k;               // hip -> flat forward
        }
        const k = Math.min(1, (fr - su - ac) / Math.max(1, rec * 0.7));
        return -0.15 + (-0.12 + 0.15) * ease(k);
      }
      // HEAVY (user): two-handed cleave — blade COCKED at an angle while it
      // comes UP, then swings to PARALLEL with the forearm as it comes DOWN.
      // Relative to the live forearm (foreAng): raised = foreAng + COCK (edge
      // laid back over the head), active = foreAng + blend(COCK -> 0), so the
      // edge lines up with the arm exactly on the chop.
      const COCK = 1.15;                                  // blade laid back of the raised forearm
      if (fr <= su) {
        return foreAng + COCK;                            // held cocked through the wind-up
      }
      if (fr <= su + ac) {
        const k = ease((fr - su) / Math.max(1, ac));      // cock -> parallel as it falls
        return foreAng + COCK * (1 - k);
      }
      const k = Math.min(1, (fr - su - ac) / Math.max(1, rec * 0.9));
      const hold = 0.5, k2 = Math.max(0, (k - hold) / (1 - hold));
      const from = foreAng;                               // follow-through: edge with the arm
      return from + (-0.12 - from) * ease(k2);
    }
    if (this.state === 'hurt') return 1.5;                // hangs from the wrist
    if (this.state === 'dash' && this.dashTimer > 0) return -2.6;  // leap: trails flat
    if (this.airborne) return -2.1;                       // carried back-up in flight
    if (this.state === 'run' || (this.state === 'dash' && !this.airborne)) {
      // walk/sprint: blade SWAYS with the gait (counterphase to the front
      // arm pendulum) — a rigid carried angle looked frozen next to pumping
      // arms. Carried up-and-forward, swinging +-25deg per stride.
      const amp = this.state === 'dash' ? 0.55 : 0.42;
      return -0.55 + amp * Math.cos(2 * Math.PI * this.cyclePhase);
    }
    // idle guard: flat, muzzle-up, tiny breathing bob.
    return -0.12 + Math.sin(this.animTime * 3) * 0.05;
  }


  // Poses are NOT pre-rendered frames: computePose runs live every frame and
  // the result is BLENDED into the previous render pose (joint-target lerp +
  // IK re-solve), so state changes flow into each other instead of popping.
  // Hitboxes/timing never see this — it is render-only smoothing.
  render() {
    const g = this.gfx;
    g.clear();
    const x = this.sprite.x;
    const feetY = this.sprite.y + CFG.body.height / 2;
    const f = this.facing;

    g.lineStyle(3.5, this.color, 1);

    const target = this.computePose(x, feetY);
    const pose = this.blendPose(target);

    // Head.
    g.strokeCircle(pose.head.x, pose.head.y, 12);
    // Torso.
    g.lineBetween(pose.neck.x, pose.neck.y, pose.hip.x, pose.hip.y);
    // Arms (two-segment).
    g.lineBetween(pose.neck.x, pose.neck.y, pose.elbowA.x, pose.elbowA.y);
    g.lineBetween(pose.elbowA.x, pose.elbowA.y, pose.handA.x, pose.handA.y);
    g.lineBetween(pose.neck.x, pose.neck.y, pose.elbowB.x, pose.elbowB.y);
    g.lineBetween(pose.elbowB.x, pose.elbowB.y, pose.handB.x, pose.handB.y);
    // Legs (two-segment).
    g.lineBetween(pose.hip.x, pose.hip.y, pose.kneeA.x, pose.kneeA.y);
    g.lineBetween(pose.kneeA.x, pose.kneeA.y, pose.footA.x, pose.footA.y);
    g.lineBetween(pose.hip.x, pose.hip.y, pose.kneeB.x, pose.kneeB.y);
    g.lineBetween(pose.kneeB.x, pose.kneeB.y, pose.footB.x, pose.footB.y);

    // Gunner: pistol in the front hand (a stub off the hand along facing);
    // muzzle flash on the shot frames (muzzleT ticks on the sim step).
    if (this.weapon === 'pistol') {
      const hx = pose.handB.x, hy = pose.handB.y;   // handB == front hand (see return map)
      g.lineStyle(3, 0xcfd6e6, 1);
      g.lineBetween(hx, hy, hx + f * 12, hy);
      g.lineBetween(hx, hy, hx - f * 3, hy + 7);   // grip
      if (this.muzzleT > 0) {
        g.fillStyle(0xffe08a, 1);
        g.fillCircle(hx + f * 16, hy, 4.5);
      }
    }

    // KATANA: rigid grip+blade object rotating around the wrist joint
    // (bladeAngleTarget), lag-blended so the tip trails the arm — the kink
    // between forearm and blade reads as the joint the straight version
    // lacked. A faint guard shimmer marks the bullet-block window.
    if (this.weapon === 'katana') {
      // The wrist angle is fully keyframed (bladeAngleTarget) now; the only
      // smoothing here is a short lerp to de-pop STATE transitions (guard ->
      // wind-up, run -> idle). During an attack we snap to the keyframe
      // (W=1) so the animation reads exactly as authored — the old adaptive
      // lag was what made attacks/running look wrong.
      // facing-space angle of the blade-side forearm (pose.handB == front hand).
      const foreAng = Math.atan2(pose.handB.y - pose.elbowB.y,
        (pose.handB.x - pose.elbowB.x) * f);
      const tgt = this.bladeAngleTarget(foreAng);
      if (typeof this._bladeAng !== 'number') this._bladeAng = tgt;
      const attacking = this.state === 'attack' && this.currentAttack
        && CFG.attacks[this.currentAttack]
        && (CFG.attacks[this.currentAttack].pose === 'slashL'
            || CFG.attacks[this.currentAttack].pose === 'slashH');
      const W = attacking ? 1 : 0.5;
      let dd = tgt - this._bladeAng;
      while (dd > Math.PI) dd -= 2 * Math.PI;
      while (dd < -Math.PI) dd += 2 * Math.PI;
      this._bladeAng += dd * W;
      const hxx = pose.handB.x, hyy = pose.handB.y;
      const bdx = Math.cos(this._bladeAng) * f, bdy = Math.sin(this._bladeAng);
      const BLADE = 46;
      const tipx = hxx + bdx * BLADE, tipy = hyy + bdy * BLADE;
      // guard shimmer (block window): a soft swept band along the blade.
      if (this.guardBoxes.length) {
        g.lineStyle(9, 0x9fd0ff, 0.18);
        g.lineBetween(hxx - bdx * 7, hyy - bdy * 7, tipx, tipy);
      }
      // grip + pommel: collinear with the blade (one rigid object), wood.
      g.lineStyle(4, 0x7a5a2e, 1);
      g.lineBetween(hxx - bdx * 9, hyy - bdy * 9, hxx, hyy);
      // blade (steel) + glint edge.
      g.lineStyle(3.5, 0xdfe6f2, 1);
      g.lineBetween(hxx, hyy, tipx, tipy);
      g.lineStyle(1.5, 0xffffff, 0.9);
      g.lineBetween(hxx + bdx * 8, hyy + bdy * 8, tipx, tipy);
      // crossguard perpendicular at the grip + wrist joint dot.
      g.lineStyle(3, 0xb8863b, 1);
      g.lineBetween(hxx - bdy * 5, hyy + bdx * 5, hxx + bdy * 5, hyy - bdx * 5);
      g.fillStyle(0xe8eef7, 1);
      g.fillCircle(hxx, hyy, 2.6);
    }

    // Debug boxes: hurtbox (cyan) + active hitbox (red).
    if (Fighter.debug) {
      g.lineStyle(1, 0x36c5ff, 0.9);
      g.strokeRect(this.sprite.x - CFG.body.width / 2, this.sprite.y - CFG.body.height / 2,
        CFG.body.width, CFG.body.height);
      if (this.hitboxes.length) {
        g.lineStyle(1, 0xff4d4d, 1);
        for (const hb of this.hitboxes) g.strokeRect(hb.x, hb.y, hb.w, hb.h);
      }
    }
  }

  blendPose(target) {
    const cur = this.renderPose;
    const snap = this._snapNext || !cur;
    this._snapNext = false;
    if (snap) { this.renderPose = target; this._renderFacing = this.facing; return target; }

    // TURNAROUND: computePose mirrors instantly on facing change; if we let
    // the blend walk feet across the body the two legs pass through each
    // other and the prev-knee bias keeps old-side bends => hyperextended
    // "satyr" knees. Mirror the whole render pose about the hip first: it
    // then sits ~on top of the new targets, so the turn reads as a pivot.
    if (this._renderFacing !== this.facing) {
      const cx = cur.hip.x;
      const mir = (pt) => ({ x: 2 * cx - pt.x, y: pt.y });
      for (const k of ['hip', 'neck', 'head', 'footA', 'footB', 'handA', 'handB',
                       'kneeA', 'kneeB', 'elbowA', 'elbowB']) cur[k] = mir(cur[k]);
      this._renderFacing = this.facing;
    }

    // Dash burst uses a faster rate: ~60% of the leap pose by frame 1, ~85%
    // by frame 2. Punchy, but the intermediate frames read as pushing off.
    const rate = (this.state === 'dash' && this.dashTimer > 0) ? 0.6 : BLEND;
    const SMOOTH = ['hip', 'neck', 'head', 'footA', 'footB', 'handA', 'handB'];
    const blended = {};
    for (const k of SMOOTH) blended[k] = {
      x: cur[k].x + (target[k].x - cur[k].x) * rate,
      y: cur[k].y + (target[k].y - cur[k].y) * rate,
    };

    // Keep hips above feet sanity: never let the blended hip sink below feet.
    const minY = Math.min(blended.footA.y, blended.footB.y);
    if (blended.hip.y > minY - 20) blended.hip.y = minY - 20;

    // Re-solve knees from (hip, blended foot) so legs stay rigid; pick the
    // IK side nearest the previous knee for continuity.
    blended.kneeA = this._reSolve(blended.hip, blended.footA, cur.kneeA, 'knee');
    blended.kneeB = this._reSolve(blended.hip, blended.footB, cur.kneeB, 'knee');
    if (target.fkElbows) {
      // FK arms (gait): side authority = which side of the TARGET neck->hand
      // line the FK model places the elbow. The FK elbow NEVER sits on its
      // own line (min flexion 12deg), so this sign is a smooth function of
      // the gait phase — history-free, cannot oscillate. History/guide-based
      // side picking was tried twice and flipped (stale dash arms; nearest-
      // candidate across the lagging blended line at the bottom of swing).
      const cr = (a, b, q) => (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
      const sideA = target.elbowSideA ?? (Math.sign(cr(target.neck, target.handA, target.elbowA)) || 1);
      const sideB = target.elbowSideB ?? (Math.sign(cr(target.neck, target.handB, target.elbowB)) || 1);
      blended.elbowA = this._reSolve(blended.neck, blended.handA, target.elbowA, 'fk', sideA);
      blended.elbowB = this._reSolve(blended.neck, blended.handB, target.elbowB, 'fk', sideB);
    } else {
      blended.elbowA = this._reSolve(blended.neck, blended.handA, cur.elbowA, 'elbow');
      blended.elbowB = this._reSolve(blended.neck, blended.handB, cur.elbowB, 'elbow');
    }
    this.renderPose = blended;
    return blended;
  }

  _reSolve(root, end, prevJoint, kind, side) {
    // CRITICAL: must use the SAME anatomical rules as ik2. Using a pure
    // "nearest to previous frame" rule here fights ik2 on the punch arm:
    // at full extension both IK solutions sit on the arm line, and when the
    // arm retracts the elbow-UP solution can be marginally closer to the
    // straight-arm position than the anatomical elbow-down one. Result was
    // the post-jab elbow popping up. Rules first, previous frame only as a
    // tie-break for genuinely ambiguous cases.
    const isKnee = kind === 'knee';
    const l1 = isKnee ? THIGH : UARM, l2 = isKnee ? SHIN : FARM;
    const facing = this.facing;
    let dx = end.x - root.x, dy = end.y - root.y;
    let d = Math.hypot(dx, dy) || 0.001;
    const maxd = l1 + l2 - 0.01;
    if (d > maxd) { const s = maxd / d; dx *= s; dy *= s; d = maxd; }
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const mx = root.x + dx * a / d, my = root.y + dy * a / d;
    const px = dy / d, py = -dx / d;
    const A = { x: mx + px * h, y: my + py * h };
    const B = { x: mx - px * h, y: my - py * h };
    // Near-straight elbows must COLLAPSE ON THE LINE, never pick a side:
    // at h~0 both solutions flank the line and 'nearest to last frame' is a
    // coin flip — that is how elbows pop up during blends (post-dash,
    // recovery). Elbows never legitimately flip sides; knees may keep
    // continuity (their rules already pin the forward side).
    if (h < 1.5 && !isKnee) return { x: mx, y: my };
    if (kind === 'fk') {
      // Enforce the target-derived side on the blended arm. h<1.5 collapses
      // ON the line (single deterministic point, no side to flip across).
      if (h < 1.5) return { x: mx, y: my };
      const cr = (a, b, q) => (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
      const crA = cr(root, end, A);
      if (Math.abs(crA) < 1e-9) return A;
      return (Math.sign(crA) === side) ? A : B;
    }
    if (h < 1.5) {   // near-straight KNEE: either solution fine; keep continuity
      return (Math.hypot(A.x - prevJoint.x, A.y - prevJoint.y) <=
              Math.hypot(B.x - prevJoint.x, B.y - prevJoint.y)) ? A : B;
    }
    if (isKnee) {
      if ((A.x - mx) * facing !== (B.x - mx) * facing)
        return (A.x - mx) * facing > 0 ? A : B;      // knee leads facing
    } else {
      // elbow trails the hand; tie-break: elbow droops (lower y = further down)
      if ((A.x - root.x) * facing !== (B.x - root.x) * facing)
        return (A.x - root.x) * facing < (B.x - root.x) * facing ? A : B;
      if (Math.abs(A.y - B.y) > 1.5) return A.y >= B.y ? A : B;
    }
    return (Math.hypot(A.x - prevJoint.x, A.y - prevJoint.y) <=
            Math.hypot(B.x - prevJoint.x, B.y - prevJoint.y)) ? A : B;
  }

  // Build joint positions for the current state/animation phase.
  // Skeleton is IK-driven: we place FOOT/HAND targets, and two-bone IK
  // solves the knee/elbow, so limbs always bend anatomically (knee forward,
  // elbow down) instead of rigid lines pivoting on the joint.
  computePose(x, feetY) {
    const f = this.facing;
    const vx = this.body ? this.body.velocity.x : 0;
    const speed = Math.abs(vx);

    let hipX = x, hipY = feetY - 40, lean = 0, headExtra = 0;
    let footF = null, footB = null;     // filled by LEG layer
    const P = (px, py) => ({ x: hipX + px, y: py });

    // ============ LEG LAYER ============
    // Legs are independent of the arms. While GROUNDED and moving, the gait
    // cycle keeps playing even underneath an attack — no more frozen-leg
    // sliding punch. Two separate cycles: WALK (normal movement) and SPRINT
    // (dash hold phase / fast attacks). Dash BURST keeps its leap pose.
    const mode = this.gaitMode();
    const atkNow = this.state === 'attack' ? (CFG.attacks[this.currentAttack] || {}) : null;
    // Attacks in the air or the dash check have SCRIPTED legs — the gait
    // layer must not take the feet over mid-move.
    const gaiting = mode !== 'none'
      && !(atkNow && (atkNow.air || this.airborne || atkNow.pose === 'dash'));

    // Per-state torso (and legs when NOT gaiting).
    switch (this.state) {
      case 'run':
        lean = mode === 'sprint' ? 0.18 : 0.14;   // brisk purposeful walk
        break;
      case 'dash':
        lean = 0.3;   // sprint base; burst leap blends over it in the gait block
        break;
      case 'jump':
      case 'fall': {
        // ONE continuous airborne pose driven by the EASED parameter airT
        // (0 = tuck at launch, 1 = reach to land; update() eases it on the
        // fixed step). No discrete jump/fall poses and no vy-snapping.
        let t = (typeof this.airT === 'number') ? this.airT : 0.5;
        t = Math.max(0, Math.min(1, t));
        const lerp = (a, b) => a + (b - a) * t;
        lean = lerp(0.07, 0.05);
        footF = P(f * lerp(10, 8),   feetY - lerp(26, 4));   // front knee tucks->down
        footB = P(f * lerp(-12, -18), feetY - lerp(10, 20));  // rear foot kicks back
        break;
      }
      case 'attack': {
        const atk = CFG.attacks[this.currentAttack] || CFG.attacks.jab;
        const fr = this.attackFrame;
        const act = fr > atk.startup && fr <= atk.startup + atk.active;
        if (atk.pose === 'upper') {          // rising fist, body extends up
          lean = act ? -0.12 : -0.02;
          footF = P(f * 10, feetY - (act ? 12 : 2)); footB = P(-f * 16, feetY - (act ? 4 : 0));
        } else if (atk.pose === 'cartwheel') {  // kick over the head, legs scissor
          lean = act ? 0.5 : -0.05;
          const k = act ? (fr - atk.startup) / Math.max(1, atk.active) : 0;
          footF = P(f * (10 + 34 * k), feetY - (act ? 20 + 30 * Math.sin(Math.PI * k) : 2));
          footB = P(-f * (18 - 30 * (act ? k : 0)), feetY - (act ? 8 + 26 * k : 0));
        } else if (atk.pose === 'sweep') {      // deep crouch, leg extended low
          lean = 0.28; hipY = feetY - 30;
          footF = P(f * (act ? 40 : 16), feetY - (act ? 3 : 0)); footB = P(-f * 12, feetY);
        } else if (atk.pose === 'hammer') {     // wind up tall, crush down
          lean = act ? 0.3 : -0.18;
          hipY = feetY - (act ? 36 : 42);
          footF = P(f * 16, feetY); footB = P(-f * (act ? 22 : 16), feetY - (act ? 6 : 0));
        } else if (atk.pose === 'axe') {        // axe kick: knee up, heel chops down-forward
          lean = act ? -0.12 : 0.06;
          footF = act ? P(f * 36, feetY - 2) : P(f * 12, feetY - 44);
          footB = P(-f * (act ? 10 : 6), feetY - (act ? 4 : 0));
        } else if (atk.pose === 'dash') {       // shoulder: lunge, trail leg flat
          lean = 0.34;
          footF = P(f * 24, feetY - (act ? 6 : 0)); footB = P(-f * 34, feetY - (act ? 12 : 2));
        } else if (atk.pose === 'airjab') {     // compact, legs tuck slightly
          lean = 0.14;
          footF = P(f * 12, feetY - 8); footB = P(-f * 14, feetY - 12);
        } else if (atk.pose === 'slashL') {     // katana light: quick step-in cut
          lean = act ? 0.14 : 0.02;
          footF = P(f * (act ? 20 : 12), feetY); footB = P(-f * (act ? 20 : 16), feetY);
        } else if (atk.pose === 'slashH') {     // katana heavy: committed cleave lunge
          lean = act ? 0.3 : -0.12;             // coil back, then commit through
          footF = P(f * (act ? 28 : 10), feetY); footB = P(-f * (act ? 30 : 22), feetY - (act ? 6 : 0));
        } else if (atk.pose === 'shoot') {      // gunner: feet planted, slight recoil lean
          lean = act ? 0.10 : -0.03;
          footF = P(f * 20, feetY); footB = P(-f * 22, feetY);
        } else if (atk.pose === 'finisher') {      // committed overhand cross: wind back, plant, throw
        if (fr <= atk.startup) {
          lean = -0.10;                            // coil onto the back foot
          footF = P(f * 10, feetY); footB = P(-f * 22, feetY);
        } else if (act) {
          lean = 0.24;                             // commit through the hip
          footF = P(f * 24, feetY); footB = P(-f * 18, feetY - 4);
        } else {
          lean = 0.16;
          footF = P(f * 20, feetY); footB = P(-f * 16, feetY);
        }
      } else if (fr <= atk.startup)      { lean = -0.06; hipY = feetY - 38;
          footF = P(f * 14, feetY); footB = P(-f * 18, feetY); }
        else if (act) { lean = 0.12; hipX = x + f * 2;
          footF = P(f * 18, feetY); footB = P(-f * 20, feetY - 8); }
        else                        { lean = 0.12;
          footF = P(f * 16, feetY); footB = P(-f * 14, feetY); }
        break;
      }
      case 'hurt':
        lean = -0.21; headExtra = -f * 5;
        footF = P(f * 16, feetY); footB = P(-f * 10, feetY - 4);
        break;
      default: { // idle stance + breathing
        const bob = Math.sin(this.animTime * 3) * 1.5;
        hipY = feetY - 38 + bob * 0.4; lean = 0.05;
        footF = P(f * 14, feetY); footB = P(-f * 12, feetY);
      }
    }

    if (gaiting) {
      // TWO SEPARATE CYCLES (they looked bad as one compromise):
      //  WALK   — long stance duty (DOUBLE SUPPORT: both feet grounded,
      //           never airborne), low foot clearance, gentle lift.
      //  SPRINT — short stance duty with a real FLIGHT phase (both feet off
      //           the ground between steps), high knee-first recovery.
      // PLANTING CONSTRAINT (both): during stance the foot sweeps backward
      // relative to the hip by exactly duty*stride, the distance the hip
      // travels, so the foot never slides on the ground (no moonwalk).
      const stride = this.strideNow();
      const sprint = mode === 'sprint';
      const duty = sprint ? 0.32 : 0.56;
      const q1 = this.cyclePhase, q2 = (this.cyclePhase + 0.5) % 1;
      // Stance sweep: sprint plants 100% (no slip at these speeds); walk uses
      // a slight scuff so cadence can drop without breaking leg rigidity.
      const SWEEP = duty * stride * (sprint ? 1 : CFG.walkSlip);
      const FWD = SWEEP * (sprint ? 0.50 : 0.47);  // heel-strike ahead of hip
      const BACK = SWEEP - FWD;                    // toe-off behind hip
      const MAXLIFT = sprint ? 24 : 13;  // sprint knee drive vs brisk-walk clearance
      const leg = (q) => {
        if (q < duty) {                            // stance: land fwd, sweep back
          const k = q / duty;
          return { x: hipX + f * (FWD - k * (FWD + BACK)), y: feetY };
        }
        const k = (q - duty) / (1 - duty);
        const ease = k * k * (3 - 2 * k);
        const lift = MAXLIFT * Math.sin(Math.PI * k);
        return { x: hipX + f * (-BACK + ease * (BACK + FWD)), y: feetY - lift };
      };
      footF = leg(q1); footB = leg(q2);
      // Hip height from a CONTINUOUS flightness measure, never a boolean.
      // The old `bothAir ? -5 : 3.5` toggled the hip 8.5px in ONE frame the
      // instant both feet crossed a -6px threshold (and flickered when a foot
      // hovered near it) — that was the sprint "body pops up for a frame".
      // aF/aB ramp 0(grounded)->1(airborne) through a height band, so the
      // hip glides instead of stepping.
      const airOf = (ft, band) =>
        Math.max(0, Math.min(1, (feetY - ft.y) / band));
      if (sprint) {
        // Body is airborne only when the LAST foot leaves -> flightness is
        // the MIN of the two feet's airborneness (both must clear to rise).
        const AF = Math.min(airOf(footF, 12), airOf(footB, 12));
        hipY = feetY - 40 + (3.5 - 8.5 * AF);   // +3.5 contact sink .. -5 flight rise
        if (this.state === 'dash' && this.dashTimer > 0) {
          // BURST: layer the push-off LEAP over the sprint gait, fading the
          // leap out as dashTimer counts down. At the final burst frame the
          // pose IS the gait pose, so burst -> sprint hand-off is continuous
          // (no snap, no teleport). ease^0.8 holds the leap ~60% of the burst,
          // then settles into the stride over the last ~4 frames.
          const w = this.dashTimer / CFG.dash.burstFrames;
          const ease = Math.pow(w, 0.8);
          const lp = (a, b) => ({ x: a.x + (b.x - a.x) * ease, y: a.y + (b.y - a.y) * ease });
          footF = lp(footF, { x: hipX + f * 17, y: feetY - 30 });  // front knee drives up
          footB = lp(footB, { x: hipX - f * 36, y: feetY - 16 });  // back leg extended push-off
          hipY += (feetY - 47 - hipY) * ease;
          lean += (0.38 - lean) * ease;
          headExtra = f * 5 * ease;
        }
      } else {
        // Walk bob: hip LOW at double support, slightly HIGH at one-leg
        // mid-stance (the classic pendulum). No flight — ever. Rise when
        // EITHER foot lifts -> max of the two feet's airborneness.
        const MF = Math.max(airOf(footF, 7), airOf(footB, 7));
        hipY = feetY - 39 + (2 - 3.5 * MF);     // +2 low .. -1.5 high
      }
    }

    // Torso from lean.
    const neck = { x: hipX + Math.sin(lean) * 34 * f, y: hipY - Math.cos(lean) * 34 };
    const head = { x: neck.x + Math.sin(lean) * 14 * f + headExtra,
                   y: neck.y - Math.cos(lean) * 14 };

    // ============ ARM LAYER ============
    let elbowF = null, elbowB = null, handF = null, handB = null;
    let uArmF = UARM, fArmF = FARM;

    if (this.state === 'attack') {
      const atk = CFG.attacks[this.currentAttack] || CFG.attacks.jab;
      const fr = this.attackFrame;
      const reach = f * (atk.box.x + atk.box.w - 12);
      const chestY = feetY - 60 + atk.box.y * 0.5;
      const act = fr > atk.startup && fr <= atk.startup + atk.active;
      if (atk.pose === 'upper') {                 // fist drives UP past the head
        if (act) { uArmF += 8; fArmF += 8;
          handF = P(f * 22, feetY - 92); handB = P(-f * 8, feetY - 62); }
        else { handF = P(f * 4, feetY - 56); handB = P(-f * 10, feetY - 64); }
      } else if (atk.pose === 'cartwheel') {      // arms down for the kick axis
        if (act) { handF = P(f * 16, feetY - 46); handB = P(-f * 18, feetY - 44); }
        else { handF = P(f * 6, feetY - 58); handB = P(-f * 12, feetY - 58); }
      } else if (atk.pose === 'sweep') {          // hand sweeps the floor line
        if (act) { handF = P(f * 34, feetY - 16); handB = P(f * 4, feetY - 58); }
        else { handF = P(f * 6, feetY - 40); handB = P(-f * 8, feetY - 60); }
      } else if (atk.pose === 'hammer') {         // wind up OVERHEAD, fist crashes down
        if (fr <= atk.startup) { uArmF += 6; fArmF += 6;
          handF = P(-f * 4, feetY - 96); handB = P(-f * 10, feetY - 70); }
        else if (act) { uArmF += 8; fArmF += 8;
          handF = P(f * 30, feetY - 34); handB = P(f * 2, feetY - 66); }
        else { handF = P(f * 20, feetY - 48); handB = P(-f * 4, feetY - 62); }
      } else if (atk.pose === 'axe') {            // arms swing down with the chop
        if (act) { handF = P(f * 18, feetY - 48); handB = P(-f * 18, feetY - 56); }
        else { handF = P(f * 10, feetY - 88); handB = P(-f * 12, feetY - 84); }
      } else if (atk.pose === 'dash') {           // shoulder check, arms tucked back
        if (act) { handF = P(f * 26, feetY - 58); handB = P(-f * 16, feetY - 56); }
        else { handF = P(f * 12, feetY - 60); handB = P(-f * 14, feetY - 58); }
      } else if (atk.pose === 'airjab') {         // short sharp forward poke
        if (act) { handF = P(f * 30, feetY - 64); handB = P(-f * 10, feetY - 66); }
        else { handF = P(f * 10, feetY - 62); handB = P(-f * 12, feetY - 64); }
      } else if (atk.pose === 'finisher') {       // overhand: rear hand arcs OVER from behind the head
        if (fr <= atk.startup) {
          handF = P(-f * 16, feetY - 78); handB = P(f * 4, feetY - 60);   // coil high-back, lead hand guards
        } else if (act) {
          const ka = (fr - atk.startup) / Math.max(1, atk.active);
          uArmF += 8; fArmF += 8;
          handF = P((atk.box.x + atk.box.w - 14) * f * (0.55 + 0.45 * ka), chestY - 6);
          handB = P(-f * 8, feetY - 62);
        } else {
          handF = P(f * 14, feetY - 58); handB = P(-f * 6, feetY - 62);   // settle off the throw
        }
      } else if (atk.pose === 'slashL') {       // katana light: horizontal cut
        if (fr <= atk.startup) {                       // draw: hand back at the hip
          handF = P(-f * 10, feetY - 52); handB = P(f * 6, feetY - 64);
        } else if (act) {                              // cut across the chest line
          const ka = (fr - atk.startup) / Math.max(1, atk.active);
          uArmF += 4; fArmF += 4;
          handF = P(f * (14 + (atk.box.x + atk.box.w - 26) * ka), feetY - 62);
          handB = P(-f * 8, feetY - 66);               // rear hand up in guard
        } else {
          handF = P(f * 18, feetY - 60); handB = P(-f * 6, feetY - 64);   // recover to guard
        }
      } else if (atk.pose === 'slashH') {       // katana heavy: committed cleave
        // Keypoint interpolation (like the hammer pose), NOT trig — a sin()
        // sign inversion had the "overhead" wind-up keeping the hand LOW (the
        // flail the user saw: no raise, then a big radius circle to recover).
        // TWO-HANDED (user): the rear hand leaves guard and reaches UP to the
        // grip during the raise, locks beside the front hand through the
        // chop (one object, two hands), then peels back to guard.
        const ease = (t) => t * t * (3 - 2 * t);
        const P2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        // (fx, height above feet); f-multiplied on x at use.
        const GUARD = [22, 60], OVER = [-6, 98], LOW = [42, 28];
        const RGUARD = [-10, 62];                        // rear hand at rest (guard)
        // Rear hand on the shoulder->front-hand line ~12px off the grip:
        // always in reach (t capped at 34 vs the 37px arm) — pinning it at a
        // fixed offset over-stretched the rear arm on the extended chop.
        const gripMate = (hf) => {
          const dx = hf.x - neck.x, dy = hf.y - neck.y;
          const d = Math.hypot(dx, dy) || 1;
          const t = Math.max(18, Math.min(d - 12, 34)) / d;
          return { x: neck.x + dx * t, y: neck.y + dy * t };
        };
        if (fr <= atk.startup) {                        // wind up: guard -> overhead
          const k = ease(Math.min(1, fr / atk.startup));
          const [hx, hy] = P2(GUARD, OVER, k);
          const [rx, ry] = P2(RGUARD, [-5, 86], k);     // rear REACHES UP to the grip
          handF = P(f * hx, feetY - hy); handB = P(f * rx, feetY - ry);
          // EXPLICIT elbows through the raise: IK flails between mirror
          // solutions as the arm passes vertical (measured forearm oscillated
          // ~1.9rad in a frame, dragging the cocked blade with it).
          elbowF = P(f * (12 - 3 * k), feetY - (54 + 32 * k));
          elbowB = P(f * (4 + 9 * k), feetY - (52 + 27 * k));
        } else if (fr <= atk.startup + atk.active) {    // the CHOP: overhead -> low fwd
          // easeOut (not smoothstep): accelerate OFF the hold immediately and
          // DECELERATE into the follow-through — a smoothstep whip-then-stop
          // reads as flail on a big committed arc.
          const raw = (fr - atk.startup) / Math.max(1, atk.active);
          const ka = 1 - (1 - raw) * (1 - raw);
          const [hx, hy] = P2(OVER, LOW, ka);
          uArmF += 10; fArmF += 10;
          handF = P(f * hx, feetY - hy);
          handB = gripMate(handF);                      // BOTH hands on the grip
        } else {                                        // hold low, then settle to guard
          const k = ease(Math.min(1, (fr - atk.startup - atk.active) / Math.max(1, atk.recovery * 0.9)));
          const hold = 0.5, k2 = Math.max(0, (k - hold) / (1 - hold));
          const [hx, hy] = P2(LOW, GUARD, k2);
          handF = P(f * hx, feetY - hy);
          const g = gripMate(handF);                    // grip-locked until it peels off
          const rx = hipX + RGUARD[0] * f, ry = feetY - RGUARD[1];
          handB = { x: g.x + (rx - g.x) * k2, y: g.y + (ry - g.y) * k2 };
        }
      } else if (atk.pose === 'shoot') {          // two-handed aim, gun at eye line
        const aim = fr <= atk.startup ? Math.min(1, fr / Math.max(1, atk.startup)) : (act ? 1 : 0.75);
        handF = P(f * (10 + 26 * aim), feetY - 62);
        handB = P(f * (4 + 20 * aim), feetY - 58);  // support hand under the firing one
      } else if (fr <= atk.startup) {             // anticipation (jab/heavy)
        handF = P(f * 2, feetY - 60); handB = P(-f * 10, feetY - 64);
      } else if (act) {                           // impact + overshoot
        const ka = (fr - atk.startup) / Math.max(1, atk.active);
        uArmF += 6; fArmF += 6;                   // animator's stretch
        handF = P(reach * (1 + 0.06 * Math.sin(Math.PI * ka)), chestY);
        handB = P(f * 6, feetY - 66);
      } else {                                    // retract with dip-back
        const k = (fr - atk.startup - atk.active) / Math.max(1, atk.recovery);
        const os = -4 * Math.sin(Math.PI * Math.min(1, k * 1.4));
        handF = P(reach * (1 - k) + f * (12 + os), chestY);
        handB = P(f * (4 + os * 0.5), feetY - 64);
      }
    } else if (this.state === 'jump' || this.state === 'fall') {
      // arms follow the SAME airborne parameter as the legs (rise: guard up;
      // fall: arms lift/back to brace), no cut at the apex. Spread into a V
      // so neither hand crowds the head: the old rear hand sat at ~(2,-28)
      // rel hip, i.e. right under the chin (head center (3,-48) r12), reading
      // as the arm folded across the throat. Now front hand drives up+front,
      // rear hand trails up+BACK with clear negative x, both outside the head.
      const t = Math.max(0, Math.min(1, (typeof this.airT === 'number') ? this.airT : 0.5));
      const lerp = (a, b) => a + (b - a) * t;
      handF = P(f * lerp(17, 19), feetY - lerp(62, 70));
      handB = P(f * lerp(-11, -18), feetY - lerp(60, 66));
    } else if (this.state === 'hurt') {
      handF = P(f * 6, feetY - 70); handB = P(-f * 4, feetY - 68);
    } else if (gaiting) {
      // Arms ride the SAME gait as the legs (walk arms with walk legs).
      //  WALK:   gentle +/-25deg pendulum, elbow softly flexed 20-55deg,
      //          hands stay near hip height — relaxed.
      //  SPRINT: big +/-52deg pendulum, elbow FLEXED ~100deg in front (fist
      //          to chest), nearly STRAIGHT trailing. Constant-elbow arms
      //          cancel horizontal travel — that was the "arms don't move".
      const sprint = mode === 'sprint';
      const A_MAX = (sprint ? 52 : 34) * Math.PI / 180;
      const bendOf = (a) => {                        // stride elbow flexion (rad)
        const t = (a / A_MAX + 1) / 2;
        return (sprint ? 12 + 88 * t : 18 + 52 * t) * Math.PI / 180;
      };
      const armAt = (a, bend) => {
        const fa = a + bend;
        const ex = neck.x + f * Math.sin(a) * UARM, ey = neck.y + Math.cos(a) * UARM;
        return { elbow: { x: ex, y: ey },
                 hand: { x: ex + f * Math.sin(fa) * FARM, y: ey + Math.cos(fa) * FARM } };
      };
      // BURST overlay blends the arm PARAMETERS (pendulum angle + flexion),
      // never elbow/hand POINTS separately: a fixed elbow while the hand
      // blends crosses the shoulder->hand line and flips the IK side (the
      // dash/sprint flip). One FK formula generating elbow+hand together
      // makes them structurally unable to disagree.
      const ease = (this.state === 'dash' && this.dashTimer > 0)
        ? Math.pow(this.dashTimer / CFG.dash.burstFrames, 0.8) : 0;
      const lp = (x, y, w) => x + (y - x) * w;
      // Sprint-start arm drive (fists pump, not windmill): front elbow fwd
      // &90deg flexed (driving fist at shoulder height), rear elbow high-back
      // with the trailing forearm angled down. Bends stay 70-90deg through
      // the blend, so the IK elbow can never go collinear with its arm.
      const LEAP_F = { a: 75 * Math.PI / 180, bend: 90 * Math.PI / 180 };
      const LEAP_B = { a: -120 * Math.PI / 180, bend: 70 * Math.PI / 180 };
      const a1 = A_MAX * Math.cos(2 * Math.PI * ((this.cyclePhase + 0.5) % 1));
      const a2 = A_MAX * Math.cos(2 * Math.PI * this.cyclePhase);
      const A = armAt(lp(a1, LEAP_F.a, ease), lp(bendOf(a1), LEAP_F.bend, ease));
      const B = armAt(lp(a2, LEAP_B.a, ease), lp(bendOf(a2), LEAP_B.bend, ease));
      handF = A.hand; elbowF = A.elbow;
      handB = B.hand; elbowB = B.elbow;
    } else {                                        // idle breathing guard
      const bob = Math.sin(this.animTime * 3) * 1.5;
      if (this.weapon === 'katana') {
        // Blade held out forward and slightly down, rear hand tucked at the
        // chest (two-hand sword stance). The blade rides the front-arm dir.
        handF = P(f * 26, feetY - 52 + bob); handB = P(f * 2, feetY - 62 + bob);
      } else {
        handF = P(f * 16, feetY - 64 + bob); handB = P(f * 4, feetY - 66 + bob);
      }
    }

    const fkElbows = elbowF !== null && elbowB !== null;  // FK arm layer (gait) owns elbows
    if (!elbowF) elbowF = ik2(neck.x, neck.y, handF.x, handF.y, uArmF, fArmF, 'elbow', f);
    if (!elbowB) elbowB = ik2(neck.x, neck.y, handB.x, handB.y, UARM, FARM, 'elbow', f);

    return {
      head, neck, hip: { x: hipX, y: hipY },
      kneeA: ik2(hipX, hipY, footB.x, footB.y, THIGH, SHIN, 'knee', f), footA: footB,
      kneeB: ik2(hipX, hipY, footF.x, footF.y, THIGH, SHIN, 'knee', f), footB: footF,
      elbowA: elbowB, handA: handB, elbowB: elbowF, handB: handF,
      fkElbows,
    };
  }

  destroy() {
    this.gfx.destroy();
    this.sprite.destroy();
  }
}
Fighter.debug = true;
Fighter.CFG = CFG;
Fighter.STEP = STEP;
