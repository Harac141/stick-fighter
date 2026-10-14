// mook.js — MookAI: a brain that FABRICATES the same input dict the keyboard
// produces and writes it to fighter.aiIn each sim step. Fighter.update() is
// input-source-blind, so a mook gets the full player moveset (walk/sprint/
// dash/jump/jab/heavy, frame data, gait, wall-block) for free — difficulty
// is just reaction delay + aggression + dash-usage knobs. Boss = knobs maxed.
//
// Human-ish sampling: decisions refresh every `react` frames (staggered per
// mook) and are HELD between refreshes — no per-frame optimal play, which is
// what makes mooks read as clumsy opponents instead of bots.

// ---- Engagement queue ------------------------------------------------------
// The "Bruce Lee crowd": a fight is a QUEUE, not a swarm. Only `slots` mooks
// may close and swing at once; everyone else holds an orbit ring around the
// player, jostling, waiting their turn. Not how a real mob behaves — it's how
// a mob BEHAVES ON SCREEN, and it's what makes 1v6 feel like carving instead
// of being crushed by a wall of bodies.
class EngagementManager {
  constructor(opts = {}) {
    this.k = Object.assign({
      slots: 1,          // concurrent attackers (1 = pure one-at-a-time)
      orbitMin: 175,     // non-holders hold this band around the player...
      orbitMax: 265,     // ...so the crowd reads as a crowd, not a pile
      handoffCool: 28,   // frames before the next challenger may take a slot
      maxHold: 200,      // no single goon hogs the slot forever
      stunGiveup: 12,    // stunned this long -> surrender the slot
    }, opts);
    this.holders = new Set();
    this.cool = 0;
  }
  holding(ai) { return this.holders.has(ai); }
  claim(ai) { if (this.cool > 0 || this.holders.size >= this.k.slots) return false;
              this.holders.add(ai); ai.holdT = 0; return true; }
  release(ai) { if (this.holders.delete(ai)) { ai.holdT = 0; this.cool = this.k.handoffCool; } }
  tick() { if (this.cool > 0) this.cool--; }
}

class MookAI {
  constructor(f, opts = {}) {
    this.f = f;
    this.mgr = opts.mgr || null;     // shared EngagementManager (null = free-for-all)
    this.holdT = 0;                  // frames holding the attack slot
    this.k = Object.assign({
      hp: 12,                // cannon fodder: 2 jabs (or a heavy+1). Elites later = knobs up.
      react: 14,           // frames between decision refreshes (higher = dumber)
      aggression: 0.55,    // chance to commit when in range (per decision)
      dashChance: 0.35,    // chance to dash-close when far
      heavyChance: 0.22,   // fraction of committed attacks that are heavies (long windup = readable)
      circleChance: 0.30,  // chance to mill in the band instead of closing
      jumpChance: 0.03,    // rare hop (looks alive, mostly cosmetic)
      range: 62,           // preferred center-to-center striking distance
      backoffFrames: 22,   // post-attack breathing room (waves need gaps)
    }, opts);
    delete this.k.mgr;
    // Gunner = SNIPER (levels.js knobs {weapon:'pistol'}, spawned on a pillar
    // top by zone {pillar:N}): holds position and fires (fast bullets, aimed
    // at the target incl. vertical), backs off only when you get close, and
    // vaults off the pillar if you climb onto it. Does NOT chase or mill —
    // the user has to hunt him down (user spec).
    this.gunner = !!opts.weapon;
    if (this.gunner) {
      this.k.range = 380;           // preferred firing band center-to-center
      this.k.dashChance = 0;        // never dashes in
      this.k.heavyChance = 0;       // only shoot (pulse maps to inp.shoot)
      this.k.jumpChance = 0;        // jumps only via explicit escape vault
      this.k.aggression = 0;        // never commits to melee
      this.fleeDist = opts.fleeDist || 200;   // back off inside this
      this.climbDist = opts.climbDist || 95;  // target ON our pillar -> bail
      this.vaultT = 0;              // >0 while vaulting (side-eject exempt window)
      this.shootT = 30 + (Math.random() * 20 | 0);   // first-shot delay (readable)
    }
    f.health = this.k.hp;
    // Per-mook personality: jitter the knobs so a pack never moves in lockstep.
    this.k.range += (Math.random() * 2 - 1) * 12;
    this.k.react += (Math.random() * 10 | 0) - 5;
    this.decT = Math.random() * this.k.react | 0;  // stagger decision clocks
    this.dec = { mode: 'wait' };
    this.st = 'wait';
    // stT = frames in current state. 'wait' starts NEGATIVE: staged arrival,
    // a pack trickles in instead of rushing as one blob.
    this.stT = -(30 + (Math.random() * 150 | 0));
    this.sustainT = 0;                              // dash-hold timer
    this.pulse = null;                              // one-frame attack pulse
    this.committed = false;                         // holder has actually swung
    f.ai = this;
  }

  // Nearest live player (fighters with an inputKey are players).
  pickTarget(fighters) {
    let best = null, bd = 1e9;
    for (const o of fighters) {
      if (o === this.f || o.dead || !o.inputKey) continue;
      const d = Math.abs(o.x - this.f.x);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  // Segment (muzzle -> target chest) vs pillar boxes: false = cover blocks
  // the shot. Mirrors stepBullets' pillar death rule, INCLUDING the muzzle
  // grace band: a bullet survives pillar overlap for its first ~12 frames
  // (~230px), so a block only counts if the shot is still inside a box past
  // that band. Gunner therefore never trades shots with a wall.
  hasLOS(f, t) {
    const lv = f.scene.level;
    if (!lv) return true;
    const mx = f.x + f.facing * 46, my = f.y - 14;
    const dx = t.x - mx, dy = (t.y - 8) - my;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return true;
    const ux = dx / dist, uy = dy / dist;
    // Muzzle grace (mirrors spawnBullet.gracePillar + stepBullets): the
    // bullet survives ~240px of pillar overlap for free — but ONLY its own
    // perch box, and only up to that distance; past it (or any OTHER pillar
    // from 0) the box is hard cover. A sniper atop a tall column therefore
    // cannot gun down someone standing at its base.
    const perch = f.scene.pillarUnder(f);
    const GRACE = 240;
    for (const p of lv.pillars) {
      let t0 = (p === perch) ? Math.min(dist, GRACE) : 0, t1 = dist;
      if (Math.abs(ux) < 1e-6) {
        if (mx < p.x || mx > p.x + p.w) continue;          // outside x-span
      } else {
        let a = (p.x - mx) / ux, b = (p.x + p.w - mx) / ux;
        if (a > b) { const s = a; a = b; b = s; }
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      }
      if (Math.abs(uy) < 1e-6) {
        if (my < p.top || my > f.scene.groundY) t1 = -1;   // outside y-span
      } else {
        let a = (p.top - my) / uy, b = (f.scene.groundY - my) / uy;
        if (a > b) { const s = a; a = b; b = s; }
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      }
      if (t0 <= t1 && t1 > GRACE) return false;
    }
    return true;
  }

  think(fighters) {
    const f = this.f;
    const inp = (f.aiIn = {});   // rebuilt every step; falsy = key up
    if (f.dead) { if (this.mgr) this.mgr.release(this); return; }
    if (f.hitstun > 0) {
      // Long-stunned holder surrenders the slot so the queue keeps moving.
      if (this.mgr && this.mgr.holding(this)) {
        this.stunT = (this.stunT || 0) + 1;
        if (this.stunT > this.mgr.k.stunGiveup) this.mgr.release(this);
      }
      return;   // stunned: hands off the controls
    }
    this.stunT = 0;

    const t = this.pickTarget(fighters);
    if (!t) return;
    const dx = t.x - f.x;
    const adx = Math.abs(dx);
    const dir = dx >= 0 ? 1 : -1;

    // ---- SNIPER (gunner): own brain, skips the melee state machine -------
    // User spec: stationary marksman on a pillar; backs off only when you get
    // close, otherwise holds position and fires. You have to hunt him down.
    if (this.gunner) {
      this.target = t;
      this.stT++;
      if (this._vaultCool > 0) this._vaultCool--;
      if (this.vaultT > 0) {                  // escaping an overrun perch
        this.vaultT--;
        if (this.vaultDir > 0) inp.right = true; else inp.left = true;
        inp.heldDir = this.vaultDir;
        if (!f.airborne) { inp.jump = true; inp.jumpHeld = true; }
        else inp.jumpHeld = true;
        this.dec = { mode: 'vault' };
        return;
      }
      const sameLevel = Math.abs(t.y - f.y) < 120;
      const away = -dir;
      // Cornered at a world edge = can't flee (stand and trade instead).
      const atEdge = (f.sprite.x > f.scene.levelWidth - 70 && away > 0)
                  || (f.sprite.x < 70 && away < 0);
      if (sameLevel && adx < this.climbDist && f._grounded && !f.currentAttack) {
        // Player climbing onto OUR perch: bail off the far side (don't get
        // shot point-blank on someone else's high ground).
        this.vaultDir = (t.x >= f.x) ? -1 : 1;   // away from the climber
        this.vaultT = 55;
        this.dec = { mode: 'vault' };
        return;
      }
      if (!f.currentAttack && f.onGround) f.facing = dir;   // track the target
      if (!f.onGround) f.facing = dir;   // NEVER fire backwards: an airborne
                                         // sniper tracks the target too (no
                                         // shots ever leave the wrong way)
      const fleeing = adx < this.fleeDist && sameLevel && f._grounded
                   && !f.currentAttack && !atEdge;
      if (fleeing) {
        const atEdge2 = (f.sprite.x > f.scene.levelWidth - 70 && away > 0)
                     || (f.sprite.x < 70 && away < 0);
        // Flee-into-a-wall -> vault it (path-length sampler; see melee
        // stuck block for why velocity can't be trusted near walls). Needs
        // TWO consecutive pinned+wall samples (kills one-off misreads), has a
        // cooldown, and NOT at a world edge — cornered means stand and trade.
        if (!this._fT && (this._vaultCool || 0) === 0 && !atEdge2) {
          this._fT = 10;
          this._fh = this._fh || [];
          this._fh.push(f.sprite.x);
          if (this._fh.length > 4) this._fh.shift();
          let path = 0;
          for (let i2 = 1; i2 < this._fh.length; i2++)
            path += Math.abs(this._fh[i2] - this._fh[i2 - 1]);
          if (path <= 40 &&
              f.scene.pillarSide(f.sprite.x + away * 30,
                                 f.sprite.y + f.body.height / 2, 20)) {
            if (this._wallSeen) {          // second consecutive sample: commit
              this.vaultDir = away; this.vaultT = 55; this._vaultCool = 60;
              this._wallSeen = false;
            } else this._wallSeen = true;
          } else this._wallSeen = false;
        }
        if (this._fT) this._fT--;
        if (away > 0) inp.right = true; else inp.left = true;
        inp.heldDir = away;
        this.dec = { mode: 'flee' };
      } else {
        // Hold position; fire on the cooldown clock (never while fleeing:
        // running flips facing and shots would go backwards). Cap: only while
        // the target is roughly on-screen — no cross-level machine-gunning.
        this.dec = { mode: 'snipe' };
        // Fire only when it's a CLEAN shot: target on-screen, cooldown clear,
        // muzzle actually faces the target (flee/vault drive can flip facing —
        // an aim-gate miss used to fall back to a backwards straight shot),
        // and the pillar LOS ray is clear (no shooting into cover).
        if (adx < 900 && !f.currentAttack && f.attackCooldown === 0
            && f.facing === dir && this.hasLOS(f, t)
            && --this.shootT <= 0) {
          this.shootT = 14 + (Math.random() * 18 | 0);
          inp.shoot = true;
        }
      }
      return;
    }

    // ---- Engagement queue bookkeeping ----
    const holding = !this.mgr || this.mgr.holding(this);
    if (this.mgr && this.mgr.holding(this)) {
      this.holdT++;
      // No hogging: too long in the slot, or the target ran far -> re-queue.
      if (this.holdT > this.mgr.k.maxHold || adx > 460) {
        this.mgr.release(this);
        this.st = 'approach'; this.stT = 0;
        this.dec = { mode: 'orbit' };
      }
    }

    // ---- State transitions (checked on decision ticks, held between) ----
    this.stT++;   // frames-in-state advances EVERY step (not per decision tick)
    // ---- Stuck-at-a-pillar-wall hop (ALL mooks, gunners included): pressing
    // toward a target with no real x-progress while a solid column is right
    // ahead = pinned against its side -> hop it. Stuck is POSITION-based
    // (sampled x), not velocity: arcade sawtooths vx every other step (drive
    // to 250, then wall-eject zeroes it), so a vx threshold oscillates and
    // never accumulates. Gated on a real pillar ahead (not a body-block wall)
    // so crowd shoving doesn't cause hop-fests.
    {
      const pressing = this.dec && (this.dec.mode === 'close' || this.dec.mode === 'band'
                                    || this.dec.mode === 'attack');
      if (!this._sxT) {                       // sample x every ~10 ticks
        this._sxT = 10;
        // Pinned = total path length over the last 4 samples stays tiny.
        // A wall-pinned body OSCILLATES (drive step then wall-eject: 1472 <->
        // 1480), so |x - x_prev| alone spikes and reset the counter every
        // other sample; net displacement over 4 samples cancels the
        // oscillation and stays 0, while real walking nets ~160.
        this._hist = this._hist || [];
        this._hist.push(f.sprite.x);
        if (this._hist.length > 4) this._hist.shift();
        let path = 0;
        for (let i = 1; i < this._hist.length; i++) path += Math.abs(this._hist[i] - this._hist[i - 1]);
        const wallAhead = !f.airborne && pressing && path <= 40
          && !!f.scene.pillarSide(f.sprite.x + (this.dec.dir || this.facing) * 30,
                                  f.sprite.y + f.body.height / 2, 20);
        this.stuckT = wallAhead ? (this.stuckT || 0) + 1 : 0;
      }
      this._sxT--;
    }
    // ~1.3 s of pinned samples -> run-up hop (fires on any tick; dec is a
    // plain field read every step, no need to wait for a decision refresh).
    // A plain vertical hop fails: side-solidarity ejects the climber at the
    // wall face (vx zeroed every tick until the feet clear the top, which the
    // jump apex can't reach for tall columns) -> the run-up sets the vault.
    if ((this.stuckT || 0) > 8) {
      this.dec = { mode: 'hop', dir: (this.dec.dir || dir || f.facing) };
      this.hopT = 0;
      this.stuckT = 0;
    }
    if (--this.decT <= 0 && this.dec.mode !== 'hop') {
      this.decT = this.k.react + (Math.random() * 8 | 0);
      switch (this.st) {
        case 'wait':
          if (this.stT > 0) { this.st = 'approach'; this.stT = 0; }
          break;
        case 'approach': {
          // Gunner: hold the firing band instead of closing to melee.
          if (this.gunner) {
            if (adx > this.k.range + 120 && Math.random() < 0.12 &&
                f.dashCooldown === 0 && f.onGround) {
              this.dec = { mode: 'dash', dir };    // reposition dash, not attack
              this.sustainT = 10;
            } else if (adx > this.k.range + 30) {
              this.dec = { mode: 'close', dir };
            } else {
              this.dec = { mode: 'band', dir };    // marksman pocket (back off too!)
            }
            if (this.stT > 40) { this.st = 'attack'; this.stT = 0; this.pulse = null;
                                 this.committed = false; this.dec = { mode: 'attack' }; }
            break;
          }
          // Queue-first: a free slot + aggression commits from anywhere (the
          // attack state itself closes the gap). No slot -> hold the ring.
          const wantAttack = Math.random() < this.k.aggression;
          if (wantAttack && (!this.mgr || (this.mgr.claim(this)))) {
            this.st = 'attack'; this.stT = 0; this.pulse = null;
            this.committed = false;                    // hasn't swung yet
            this.dec = { mode: 'attack' };
          } else if (this.mgr) {
            this.st = 'circle'; this.stT = 0;
            this.dec = { mode: 'orbit' };
          } else if (adx > 230 && Math.random() < this.k.dashChance &&
                     f.dashCooldown === 0 && f.onGround) {
            this.dec = { mode: 'dash', dir };
            this.sustainT = 18;
          } else if (Math.random() < this.k.jumpChance && f.onGround) {
            this.dec = { mode: 'jump', dir };
          } else {
            this.dec = { mode: 'close', dir };
          }
          break;
        }
        case 'circle':   // mill in the striking band; lulls make crowds readable
          if (this.stT > 90 || Math.random() < 0.2) { this.st = 'approach'; this.stT = 0; }
          break;
        case 'attack':
          if (this.committed && !f.currentAttack && f.attackCooldown === 0) {
            // A real swing happened and finished -> give up the slot (the
            // queue's handoff cooldown paces who comes in next). Without the
            // committed gate a fresh claimant "finishes" an attack it never
            // started and releases instantly (nobody ever lands).
            if (this.mgr) this.mgr.release(this);
            this.st = 'back'; this.stT = 0;
            this.dec = { mode: 'back', dir };
          } else if (this.stT > 130) {
            // Wedged (can't reach: body-blocked, target dodged): re-think.
            if (this.mgr) this.mgr.release(this);
            this.st = 'approach'; this.stT = 0;
            this.dec = { mode: 'close', dir };
          }
          break;
        case 'back':
          if (this.stT >= this.k.backoffFrames) { this.st = 'approach'; this.stT = 0; }
          else this.dec = { mode: 'back', dir };
          break;
      }
      // Commit an attack the moment we're in range and facing is honest.
      if (this.st === 'attack' && !this.pulse && !f.currentAttack &&
          adx <= this.k.range + 14 && f.facing === dir && f.attackCooldown === 0) {
        // Gunner: fires bullets (input.shoot -> 'shoot' attack -> spawnBullet).
        this.pulse = this.gunner ? 'shoot' : (Math.random() < this.k.heavyChance ? 'heavy' : 'jab');
      }
    }

    // ---- Apply current decision to the fabricated input dict ----
    const press = (d) => {
      if (d > 0) inp.right = true; else inp.left = true;
      inp.heldDir = d;
    };
    switch (this.dec.mode) {
      case 'close': press(dir); break;
      case 'back':  press(-dir); break;
      case 'band':  // hold the pocket: closer than the band -> back off, wider -> close in
        if (adx > this.k.range + 18) press(dir);
        else if (adx < this.k.range - 18) press(-dir);
        break;
      case 'orbit':  // queued crowd: hold the spectator ring, face the fight
        if (!f.airborne) inp.heldDir = dir;   // press-intent toward target for wall logic
        if (this.mgr && adx > this.mgr.k.orbitMax) press(dir);
        else if (this.mgr && adx < this.mgr.k.orbitMin) press(-dir);
        break;
      case 'dash':
        press(this.dec.dir);
        if (f.dashCooldown === 0 && f.onGround && f.state !== 'dash') {
          inp.dash = true; inp.dashSrc = 'tap';   // tap-style: sustains on dir
        } else if (this.sustainT > 0) {
          inp.dashHeld = true; this.sustainT--;   // keep sprinting toward the target
        } else {
          this.dec = { mode: 'close', dir };
        }
        break;
      case 'jump':
        press(dir);
        inp.jump = !f.airborne; inp.jumpHeld = true;
        if (!f.airborne) this.dec = { mode: 'close', dir };
        break;
      case 'hop': {
        // Wall vault: hold-press toward the target and jump with full height.
        // Rising bodies are exempt from pillar side-ejection (main.js), so the
        // horizontal drive survives the climb and the swept landing catches
        // the column top. (The earlier back-up-then-charge variant fired the
        // jump while backing away and landed on the near side.)
        this.hopT = (this.hopT || 0) + 1;
        press(this.dec.dir);
        if (!f.airborne) { inp.jump = true; inp.jumpHeld = true; }
        else inp.jumpHeld = true;
        if (f._grounded && this.hopT > 8) this.dec = { mode: 'close', dir };
        else if (this.hopT > 120) this.dec = { mode: 'close', dir };   // bail
        break;
      }
      case 'attack':
        // Keep the approach honest while facing settles; pulse fires once.
        if (f.facing !== dir || adx > this.k.range) press(dir);
        if (this.pulse) { inp[this.pulse] = true; this.pulse = null; this.committed = true; }
        break;
      case 'wait': break;
    }
  }
}
