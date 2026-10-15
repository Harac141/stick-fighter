// ============================================================================
// STYLE MANAGER — roguelike power system, v1 skeleton (?style=1).
//
// Design (user brief, Oct 2026):
//  * POWER POINTS (SP) come ONLY from kill OVERKILL: damage beyond the HP the
//    victim had left, capped per hit. Kills by NPC bullets, gunners, pit
//    deaths etc. pay nothing — credit travels on hb.attacker and only
//    scene.p1 counts, so camping/watching the sniper earn zero (user's
//    anti-camp rule, enforced by attribution not by penalties).
//  * ENERGY is the spendable activation currency (mana-bar model, user's
//    call over a decaying meter). Anti-hoarding levers (user's Risk-of-Rain
//    worry): (1) the bar CAPS — unused energy overflows and is wasted,
//    (2) it regenerates passively, so hoarding wastes regen too, and
//    (3) powers do NOT scale with stored energy: using it now costs exactly
//    the same as saving it, so there is nothing to gain by saving.
//  * ARMOR is the secondary buffer bullet time chews through after energy
//    (and then HP) — "drains energy quickly" but a hoarded bar never
//    blocks using the power, it just runs out.
//  * POWERS occupy SLOTS. New powers are bought between waves (pick 1 of 3,
//    or skip) with SP. v1 pool: BULLET TIME (Q hold), IMBUE (E), DRAIN (R).
//  * No audio/visual reward work yet (user: get the core right first).
//
// Tuning knobs live in STYLE_T below — all costs/amounts, one place.
// ============================================================================

const STYLE_T = {
  spCapPerKill: 10,        // overkill credit cap per killing hit (pistol-proof)
  costPerBuy: 10,          // SP to take a NEW power at the wave offer
  upgradeCost: [0, 10, 15],// SP cost to reach level 2 / 3 of a power
  energyMax: 100,
  energyStart: 40,
  energyRegen: 2,          // per second (hoard-punishing trickle)
  energyPerHit: 2,         // player attack lands
  energyPerSwat: 15,       // first deflection of a bullet
  energyPerKill: 12,
  armorMax: 100,
  armorPerWave: 25,        // armor restored on wave clear
  imbueCost: 40, imbueFrames: 360, imbueMult: [0, 2, 2.5, 3],
  drainCost: 40, drainFrames: 360, drainHeal: [0, 0.5, 0.65, 0.8],
  slowMinEnergy: 5,
  slowDrain: [0, 25, 20, 16],   // energy/s while Q held (by level)
  slowFactor: [0, 0.25, 0.2, 0.15], // world speed multiplier for non-player bodies
  hpDrain: 10,             // HP/s once energy AND armor are gone
};

const STYLE_DEFS = {
  slow:  { key: 'Q', name: 'BULLET TIME', slots: 1, maxLvl: 3,
           desc: 'Hold Q: world at 25% speed. Drains energy, then armor, then HP.' },
  imbue: { key: 'E', name: 'IMBUE', slots: 1, maxLvl: 3,
           desc: 'E: 6s, your attacks deal x2/x2.5/x3 damage.' },
  drain: { key: 'R', name: 'DRAIN', slots: 1, maxLvl: 3,
           desc: 'R: 6s, heal a % of the damage you deal.' },
};

class StyleManager {
  constructor(scene) {
    this.scene = scene;
    this.pts = 0;
    this.energy = STYLE_T.energyStart;
    this.armor = STYLE_T.armorMax;
    this.slots = [null, null, null];     // power ids (3 slots for the 3 v1 powers)
    this.levels = {};                    // id -> level (1..3)
    this.slowActive = false;             // Q held this step (tick() owns)
    this.slowHeld = false;               // raw Q key state (scene key handler)
    this.slowFactor = 1;                 // scene reads this for the world gate
    this.imbueT = 0;
    this.drainT = 0;
    this.pending = null;                 // offer/dead overlay -> sim frozen, pick via keys
    this.offerChoices = null;            // [id,id,id] shown at wave clear
    this.offered = false;                // one-shot: re-armed when mooks spawn
    this.kills = 0;
    this.spEarned = 0;
    this._acc = 0;                       // 1s regen accumulator
  }

  has(id)  { return this.levels[id] != null; }
  lvl(id)  { return this.levels[id] || 0; }
  freeSlot() { return this.slots.findIndex((s) => s === null); }

  addEnergy(n) { this.energy = Math.min(STYLE_T.energyMax, this.energy + n); }
  // The hoard answer: overflow is LOST. Stored energy buys you nothing extra.
  spend(n) { if (this.energy < n) return false; this.energy -= n; return true; }

  // ---- Credit (called from Fighter.takeHit at KO) ------------------------
  // overkill = damage - hp before the killing hit. Only scene.p1 attacks pay.
  creditKill(victim, overkill, attacker) {
    if (attacker !== this.scene.p1) return;   // NPC/environment kills: FREE
    const gain = Math.max(0, Math.min(STYLE_T.spCapPerKill, Math.round(overkill)));
    this.pts += gain; this.spEarned += gain; this.kills++;
    this.addEnergy(STYLE_T.energyPerKill);
    this.lastKill = { gain, overkill: Math.round(overkill) };
  }

  // Called from scene.onHitFeedback for every landed attack hitbox.
  // Hitboxes are tagged by Fighter.tickAttack: hb.attacker is the fighter.
  onPlayerHit(hb) {
    if (hb.attacker === this.scene.p1) this.addEnergy(STYLE_T.energyPerHit);
  }

  // Called from scene.swatBullets on the FIRST deflection of a bullet.
  onSwat(by) { if (by === this.scene.p1) this.addEnergy(STYLE_T.energyPerSwat); }

  // ---- Activation (called from scene key handlers / tick) ----------------
  pressImbue() {
    if (!this.has('imbue') || this.imbueT > 0 || this.pending) return;
    if (this.spend(STYLE_T.imbueCost)) this.imbueT = STYLE_T.imbueFrames;
  }
  pressDrain() {
    if (!this.has('drain') || this.drainT > 0 || this.pending) return;
    if (this.spend(STYLE_T.drainCost)) this.drainT = STYLE_T.drainFrames;
  }
  // Drain heal: called by scene when a player hit lands (damage already scaled).
  healFor(dmgDealt) {
    if (this.drainT <= 0) return;
    const p1 = this.scene.p1;
    if (!p1 || p1.dead) return;
    const pct = STYLE_T.drainHeal[this.lvl('drain')] || 0;
    p1.health = Math.min(100, p1.health + dmgDealt * pct);
  }

  // ---- Per-sim-step tick ---------------------------------------------------
  tick() {
    const T = STYLE_T, p1 = this.scene.p1;

    // Passive energy trickle (cap = waste).
    this._acc += 1 / 60;
    if (this._acc >= 1) { this._acc -= 1; this.addEnergy(T.energyRegen); }

    if (this.imbueT > 0) {
      this.imbueT--;
      p1.imbueMult = T.imbueMult[this.lvl('imbue')] || 1;
      if (this.imbueT === 0) p1.imbueMult = 1;
    } else p1.imbueMult = 1;
    if (this.drainT > 0) this.drainT--;

    // Bullet time: hold-to-drain. Needs a little energy to START (no free
    // face-melting), then falls through energy -> armor -> HP while held.
    const wantSlow = this.has('slow') && this.slowHeld && !this.pending &&
                     !p1.dead && this.energy > 0;
    if (wantSlow) {
      const dE = T.slowDrain[this.lvl('slow')] / 60;    // per frame
      if (this.energy >= dE) this.energy -= dE;
      else {
        this.energy = 0;
        const dA = T.slowDrain[this.lvl('slow')] / 60 * 0.5;
        if (this.armor >= dA) this.armor -= dA;
        else { this.armor = 0; p1.health = Math.max(1, p1.health - T.hpDrain / 60); }
      }
      this.slowActive = true;
      this.slowFactor = T.slowFactor[this.lvl('slow')] || 0.25;
    } else { this.slowActive = false; this.slowFactor = 1; }

    // Run over.
    if (p1.dead && !this.pending) { this.pending = 'dead'; this.slowHeld = false; }
  }

  // ---- Wave-clear offer ----------------------------------------------------
  offerNow() {
    if (this.pending) return;
    this.offered = true;                 // re-armed by spawnMooks/fireZone
    this.armor = Math.min(STYLE_T.armorMax, this.armor + STYLE_T.armorPerWave);
    // Pool: every power not yet at max level.
    const pool = Object.keys(STYLE_DEFS).filter((id) => this.lvl(id) < STYLE_DEFS[id].maxLvl);
    if (!pool.length) return;
    // 3 distinct picks (or fewer if the pool is small).
    const picks = [];
    const bag = pool.slice();
    while (picks.length < 3 && bag.length) picks.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
    this.offerChoices = picks;
    this.pending = 'offer';
  }

  pickOffer(i) {
    if (this.pending !== 'offer') return;
    const id = this.offerChoices && this.offerChoices[i];
    if (id != null) {
      const nl = this.lvl(id) + 1;
      const cost = nl === 1 ? STYLE_T.costPerBuy : STYLE_T.upgradeCost[nl - 1];
      if (nl === 1) {
        const s = this.freeSlot();
        if (s >= 0 && this.pts >= cost) { this.pts -= cost; this.slots[s] = id; this.levels[id] = 1; }
      } else if (this.pts >= cost) {
        this.pts -= cost; this.levels[id] = nl;
      }
    }
    this.pending = null; this.offerChoices = null;
  }

  // One text line, drawn by the scene HUD (no visuals beyond core need).
  hudLine() {
    const acts = [];
    if (this.has('imbue')) acts.push('E imbue ' + STYLE_T.imbueCost);
    if (this.has('drain')) acts.push('R drain ' + STYLE_T.drainCost);
    if (this.has('slow')) acts.push('Q slow');
    return 'SP ' + this.pts + '  EN ' + Math.round(this.energy) + '/' + STYLE_T.energyMax +
           '  ARM ' + Math.round(this.armor) + '  KILLS ' + this.kills +
           (acts.length ? '   ' + acts.join('  ') : '   (kill with overkill, clear a wave to buy)');
  }
}

window.StyleManager = StyleManager;
window.STYLE_DEFS = STYLE_DEFS;
window.STYLE_T = STYLE_T;
