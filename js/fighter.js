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
  jump:     { velocity: -640, cutMultiplier: 0.45 },   // variable jump height
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
    jab: {
      startup: 2, active: 3, recovery: 5,   // 10-frame jab (was 16)
      damage: 6,
      box:   { x: 34, y: -14, w: 46, h: 22 }, // relative to fighter center, facing right
      knock: { x: 260, y: -140, hitstun: 14 },
      cooldown: 6,
    },
    heavy: {
      startup: 9, active: 5, recovery: 20,
      damage: 14,
      box:   { x: 30, y: 4, w: 58, h: 26 },
      knock: { x: 520, y: -360, hitstun: 26 },
      cooldown: 14,
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
      knock: { x: 140, y: -280, hitstun: 22 },
      knockScale: true,                         // + speed*0.8: 560 dash slams across arena
      cooldown: 10,
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

    // Hitboxes (spawned fresh per attack active window).
    this.hitboxes = [];        // {x,y,w,h,...} world-space rect (left,top,w,h)
  }

  get onGround() { return this.sprite.body.blocked.down; }

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
    if (this.attackCooldown > 0) this.attackCooldown--;

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
    const H = !!input.heavy, L = !!input.jab;
    if (!H && !L) return null;
    if (this.state === 'dash' && this.dashTimer > 0) return 'dashatk';
    if (this.airborne) {
      // W is the ONLY up-indicator (no jump-timing guesswork — that was the
      // untimable "rising" heuristic). air K always = axe kick.
      if (input.up) return H ? 'cartwheel' : 'uppercut';
      if (H) return 'axekick';
      return 'airjab';
    }
    if (input.up) return H ? 'cartwheel' : 'uppercut';   // up+attack = launcher, no jump needed
    if (input.down) return H ? 'hammerfist' : 'sweep';   // (also works from run)
    return H ? 'heavy' : 'jab';
  }

  startAttack(name) {
    const atk = CFG.attacks[name];
    this.currentAttack = name;
    this.attackFrame = 0;
    this.hitConfirmed = false;
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
      this.state = this.airborne ? 'fall' : 'idle';
    }
    // Slight forward step on the ground during startup+active of heavy.
    if (this.currentAttack === 'heavy' && !this.airborne
        && this.attackFrame > atk.startup - 3 && this.attackFrame <= activeEnd) {
      // Lunge drive is ADDED to (capped by) existing momentum, never overwrites it.
      this.body.setVelocityX(this.approach(this.body.velocity.x,
        this.facing * Math.max(Math.abs(this.body.velocity.x), 170), 600 * STEP));
    }
  }

  attackWorldBox(atk) {
    const cx = this.x + this.facing * atk.box.x;
    const cy = this.y + atk.box.y;
    // box.x is "distance from center"; convert to a left/top rect.
    return {
      x: this.facing === 1 ? cx : cx - atk.box.w,
      y: cy - atk.box.h / 2,
      w: atk.box.w,
      h: atk.box.h,
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
    const fling = this.facing * (2 + Math.random() * 3);
    const lieDir = (Math.sign(v.x || -this.facing) * this.facing) >= 0 ? 1 : -1;
    this.ragdoll = {
      t: 0, frames: 0, alpha: 1, settled: false, freeze: null, restLeft: 0, gnd: false,
      hipY: this.sprite.y + 10,   // drawn pivot; ragStep owns it (flight rides sprite, blend sinks it)
      sprawl: null, sprawlDone: false, vy0,
      torso: { th: this.facing * (0.30 + Math.random() * 0.45), thv: fling, th0: lieDir * (1.3 + Math.random() * 0.2) },
      legA:  { th: rnd(0.5), thv: v.x * 0.004 + rnd(7) },
      legB:  { th: rnd(0.5), thv: v.x * 0.004 + rnd(7) },
      armA:  { th: rnd(0.7), thv: v.x * 0.005 + rnd(9) },
      armB:  { th: rnd(0.7), thv: v.x * 0.005 + rnd(9) },
    };
    // Meteor spikes: skip the pop, slam straight down.
    if (hb && hb.meteor) { v.y = Math.max(v.y, 420); this.ragdoll.vy0 = v.y; this.ragdoll.torso.thv = this.facing * 6; }
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

    // Floor. (ragdoll-local ground flag: `onGround` reads arcade blocked.down,
    // which never updates while the body is disabled.)
    const centerY = this.scene.groundY - CFG.body.height / 2;
    const onGnd = this.sprite.y >= centerY - 0.5;
    if (onGnd) {
      this.sprite.y = centerY;
      // LIE-DOWN: first ground contact starts a SHORT pose blend (user:
      // "over a couple frames", not instant, not smoothed-with-springs).
      // 4-frame angle lerp into an explicit lying pose (torso flat, head on
      // the knock side, legs extended trailing, arms flopped). No springs
      // involved — scripted blend of angles only.
        if (!rd.sprawl && !rd.sprawlDone) {
          const dirX = Math.sign(v.x || this.facing) || 1;
          const whip = Math.min(Math.max(v.y, 0), 600) * 0.0022 * dirX;
          const f = this.facing;
          // LEAN from the LAUNCH (user): killed going UP (uppercut/cartwheel;
          // vy0 << 0) they land on their BACK — head trails the travel,
          // arms flung overhead. Killed going DOWN (axe kick/meteor; vy0 >> 0)
          // they FACEPLANT — head leads the slide, arms reaching forward,
          // deeper over-rotation. Near-flat kills mix randomly. Deeper |lean|
          // rotates further past flat (one shoulder up) — so each finisher's
          // corpse reads differently.
          const lean = Math.max(-1, Math.min(1, (rd.vy0 || 0) / 640));  // -1 up, +1 down
          const headWorld = lean > 0.15 ? dirX
                          : lean < -0.15 ? -dirX
                          : (Math.random() < 0.5 ? dirX : -dirX);
          const over = 1.28 + Math.abs(lean) * 0.30 + Math.random() * 0.08;
          rd.sprawl = {
            t: 0, frames: K.sprawlFrames,
            from: { torso: rd.torso.th, legA: rd.legA.th, legB: rd.legB.th, armA: rd.armA.th, armB: rd.armB.th },
            to: {
              torso: headWorld * over * f + whip * 0.2,
              legA: -headWorld * (1.22 + Math.random() * 0.25) * f,
              legB: -headWorld * (1.05 + Math.random() * 0.35) * f,   // one leg less straight
              armA: (lean < -0.15 ? headWorld : (Math.random() < 0.5 ? 1 : -1)) * (0.95 + Math.random() * 0.55) * f,
              armB: (lean > 0.15 ? headWorld : (Math.random() < 0.5 ? 1 : -1)) * (0.95 + Math.random() * 0.55) * f,
            },
            hipFrom: rd.hipY, hipTo: this.scene.groundY - 14,
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
      rd.hipY = lerp(s.hipFrom, s.hipTo);
      if (u >= 1) { rd.sprawl = null; rd.sprawlDone = true; }
    }

    // Joint springs: airborne flail ONLY (limbs whip underdamped on the way
    // down); on the ground the lie-down blend owns the angles.
    const grounded = onGnd && v.y === 0;
    rd.gnd = grounded;
    if (!grounded && !rd.sprawl) {
      const set = (j, rest) => {
        j.thv += (-K.airK * (j.th - rest) - K.airC * j.thv) * dt;
        j.th += j.thv * dt;
      };
      set(rd.torso, rd.torso.th0 * 0.55);
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
    const footA = seg(kneeA.x, kneeA.y, rd.legA.th * 0.7 * f, 24);
    const kneeB = seg(hip.x, hip.y, rd.legB.th * f, 24);
    const footB = seg(kneeB.x, kneeB.y, rd.legB.th * 0.7 * f, 24);
    // FLOOR CLAMP (user: legs sank through the ground): FK has no floor
    // constraint, so sprawl angles can drive feet/hands below the floor line.
    // Pin contact points at the floor; segment lengths shorten a hair when
    // clamped — invisible on stick lines, and better than subterranean limbs.
    const floor = this.scene.groundY;
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
    this.state = 'hurt';
    // Meteor spike: slam down, then a bounce + scramble delay on landing.
    if (hb.meteor) this.meteorPending = true;
    // KO AFTER knockback lands — the ragdoll inherits the corpse's velocity.
    if (this.health === 0 && !this.dead) this.ko(hb);   // mooks KO; players too (duel KO later)
  }

  // ---- Rendering ----------------------------------------------------------
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
      handF = P(f * 16, feetY - 64 + bob); handB = P(f * 4, feetY - 66 + bob);
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
