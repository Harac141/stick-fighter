// mook.js — MookAI: a brain that FABRICATES the same input dict the keyboard
// produces and writes it to fighter.aiIn each sim step. Fighter.update() is
// input-source-blind, so a mook gets the full player moveset (walk/sprint/
// dash/jump/jab/heavy, frame data, gait, wall-block) for free — difficulty
// is just reaction delay + aggression + dash-usage knobs. Boss = knobs maxed.
//
// Human-ish sampling: decisions refresh every `react` frames (staggered per
// mook) and are HELD between refreshes — no per-frame optimal play, which is
// what makes mooks read as clumsy opponents instead of bots.

class MookAI {
  constructor(f, opts = {}) {
    this.f = f;
    this.k = Object.assign({
      react: 14,           // frames between decision refreshes (higher = dumber)
      aggression: 0.55,    // chance to commit when in range (per decision)
      dashChance: 0.35,    // chance to dash-close when far
      heavyChance: 0.22,   // fraction of committed attacks that are heavies (long windup = readable)
      circleChance: 0.30,  // chance to mill in the band instead of closing
      jumpChance: 0.03,    // rare hop (looks alive, mostly cosmetic)
      range: 62,           // preferred center-to-center striking distance
      backoffFrames: 22,   // post-attack breathing room (waves need gaps)
    }, opts);
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

  think(fighters) {
    const f = this.f;
    const inp = (f.aiIn = {});   // rebuilt every step; falsy = key up
    if (f.dead || f.hitstun > 0) return;   // stunned: hands off the controls

    const t = this.pickTarget(fighters);
    if (!t) return;
    const dx = t.x - f.x;
    const adx = Math.abs(dx);
    const dir = dx >= 0 ? 1 : -1;

    // ---- State transitions (checked on decision ticks, held between) ----
    this.stT++;   // frames-in-state advances EVERY step (not per decision tick)
    if (--this.decT <= 0) {
      this.decT = this.k.react + (Math.random() * 8 | 0);
      switch (this.st) {
        case 'wait':
          if (this.stT > 0) { this.st = 'approach'; this.stT = 0; }
          break;
        case 'approach':
          if (adx <= this.k.range + 12) {
            if (Math.random() < this.k.aggression) {
              this.st = 'attack'; this.stT = 0; this.pulse = null;
              this.dec = { mode: 'attack' };          // apply-switch needs this
            } else if (Math.random() < this.k.circleChance) {
              this.st = 'circle'; this.stT = 0;
              this.dec = { mode: 'band', dir };
            }
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
        case 'circle':   // mill in the striking band; lulls make crowds readable
          if (this.stT > 90 || Math.random() < 0.2) { this.st = 'approach'; this.stT = 0; }
          break;
        case 'attack':
          if (!f.currentAttack && f.attackCooldown === 0) {
            // Attack finished -> step back for a breather (waves need gaps).
            this.st = 'back'; this.stT = 0;
            this.dec = { mode: 'back', dir };
          } else if (this.stT > 90) {
            // Wedged (can't reach: body-blocked, target dodged): re-think.
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
        this.pulse = Math.random() < this.k.heavyChance ? 'heavy' : 'jab';
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
      case 'attack':
        // Keep the approach honest while facing settles; pulse fires once.
        if (f.facing !== dir || adx > this.k.range) press(dir);
        if (this.pulse) { inp[this.pulse] = true; this.pulse = null; }
        break;
      case 'wait': break;
    }
  }
}
