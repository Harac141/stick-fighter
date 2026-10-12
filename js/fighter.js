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
  run:      { accel: 3000, turnDecel: 2600, maxSpeed: 250, friction: 500 },  // friction = release skid (slider-bound); 2400 = old abrupt stop
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
    this.animTime = 0;         // seconds, drives idle bob
    this.cyclePhase = 0;       // 0..1 gait phase, advanced by ACTUAL speed (no foot slip)
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
      if (this.hitstun === 0 && this.onGround) {
        this.state = 'idle';
      }
      this.physicsStep(false);
      return;
    }

    // Air/ground bookkeeping.
    this.airborne = !this.onGround;

    // Advance gait by ACTUAL distance travelled — runs during attacks and
    // dash-exit slides too (legs keep cycling whenever the feet are moving).
    if (!this.airborne && Math.abs(this.body.velocity.x) > 20) {
      this.cyclePhase = (this.cyclePhase + Math.abs(this.body.velocity.x) * STEP / this.strideNow()) % 1;
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
      if (input.heavy && this.canStartAttack()) { this.startAttack('heavy'); return; }
      if (input.jab   && this.canStartAttack()) { this.startAttack('jab');   return; }
    }

    // ---- Dash (ground only) ----
    if (input.dash && this.dashCooldown === 0 && this.state !== 'dash'
        && this.onGround && (this.state === 'idle' || this.state === 'run')) {
      // Dash in the direction being held, else face.
      const dir = input.left ? -1 : (input.right ? 1 : this.facing);
      this.facing = dir;
      this.state = 'dash';
      this._snapNext = true;   // instant read on trigger (blended OUT by design)
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
        if (Math.abs(this.body.velocity.x) > 20) this.state = 'run';
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
    this.hitboxes.length = 0;
    if (this.attackFrame > activeStart && this.attackFrame <= activeEnd && !this.hitConfirmed) {
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
      knock: atk.knock,
    };
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

    const SMOOTH = ['hip', 'neck', 'head', 'footA', 'footB', 'handA', 'handB'];
    const blended = {};
    for (const k of SMOOTH) blended[k] = {
      x: cur[k].x + (target[k].x - cur[k].x) * BLEND,
      y: cur[k].y + (target[k].y - cur[k].y) * BLEND,
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
      const sideA = Math.sign(cr(target.neck, target.handA, target.elbowA)) || 1;
      const sideB = Math.sign(cr(target.neck, target.handB, target.elbowB)) || 1;
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
    const gaiting = mode !== 'none';

    // Per-state torso (and legs when NOT gaiting).
    switch (this.state) {
      case 'run':
        lean = mode === 'sprint' ? 0.18 : 0.14;   // brisk purposeful walk
        break;
      case 'dash':
        lean = 0.3;   // sprint base; burst leap blends over it in the gait block
        break;
      case 'jump':
        lean = 0.07;
        footF = P(f * 10, feetY - 26); footB = P(-f * 12, feetY - 10);
        break;
      case 'fall':
        lean = 0.05;
        footF = P(f * 8, feetY - 6); footB = P(-f * 16, feetY - 18);
        break;
      case 'attack': {
        const atk = CFG.attacks[this.currentAttack] || CFG.attacks.jab;
        const fr = this.attackFrame;
        if (fr <= atk.startup)      { lean = -0.06; hipY = feetY - 38;
          footF = P(f * 14, feetY); footB = P(-f * 18, feetY); }
        else if (fr <= atk.startup + atk.active) { lean = 0.12; hipX = x + f * 2;
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
      if (sprint) {
        // True flight = BOTH feet actually off the ground (trusting height
        // over phase windows avoids IK over-stretch at toe-off).
        const bothAir = footF.y < feetY - 6 && footB.y < feetY - 6;
        hipY = feetY - 40 + (bothAir ? -5 : 3.5);   // rise in flight, sink at contact
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
        // mid-stance (the classic walk pendulum). No flight — ever.
        const doubleSupport = footF.y >= feetY - 1 && footB.y >= feetY - 1;
        hipY = feetY - 39 + (doubleSupport ? 2 : -1.5);
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
      if (fr <= atk.startup) {                    // anticipation
        handF = P(f * 2, feetY - 60); handB = P(-f * 10, feetY - 64);
      } else if (fr <= atk.startup + atk.active) {// impact + overshoot
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
    } else if (this.state === 'jump') {
      handF = P(f * 14, feetY - 66); handB = P(f * 2, feetY - 68);
    } else if (this.state === 'fall') {
      handF = P(f * 12, feetY - 72); handB = P(-f * 8, feetY - 70);
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
      const armAt = (a) => {
        const t = (a / A_MAX + 1) / 2;                     // 0 back .. 1 front
        const bend = (sprint ? 12 + 88 * t : 18 + 52 * t) * Math.PI / 180;
        const fa = a + bend;
        const ex = neck.x + f * Math.sin(a) * UARM, ey = neck.y + Math.cos(a) * UARM;
        return { elbow: { x: ex, y: ey },
                 hand: { x: ex + f * Math.sin(fa) * FARM, y: ey + Math.cos(fa) * FARM } };
      };
      const a1 = A_MAX * Math.cos(2 * Math.PI * ((this.cyclePhase + 0.5) % 1));
      const a2 = A_MAX * Math.cos(2 * Math.PI * this.cyclePhase);
      const A = armAt(a1), B = armAt(a2);          // opposite phase to legs
      handF = A.hand; elbowF = A.elbow;
      handB = B.hand; elbowB = B.elbow;
      if (this.state === 'dash' && this.dashTimer > 0) {
        // leap arms (up-and-back, long-jump takeoff) fading into the pump
        const ease = Math.pow(this.dashTimer / CFG.dash.burstFrames, 0.8);
        const lp = (a, b) => ({ x: a.x + (b.x - a.x) * ease, y: a.y + (b.y - a.y) * ease });
        handF = lp(handF, { x: hipX + f * 22, y: feetY - 70 });
        handB = lp(handB, { x: hipX - f * 18, y: feetY - 50 });
        elbowF = lp(elbowF, { x: neck.x + f * 10, y: neck.y - 8 });
        elbowB = lp(elbowB, { x: neck.x - f * 12, y: neck.y + 2 });
      }
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
