// ============================================================================
// LOADOUT MANAGER — swappable HEAVY moves + energy economy (base brawler).
//
// Design (user brief, Oct 2026): "let you have builds for your favorite
// characters... normal attacks stay the same, but the heavy attacks can be
// swapped out." Three slots (K, W+K, S+K). Movesets mix-and-mash across
// slots; every swappable move carries a fixed ENERGY cost and a DIRECTION
// binding ('neutral' | 'up' | 'down' | 'none'). A 'none' move (abilities
// like a time-slow/buff) activates from any heavy press regardless of
// modifier — "a time slow ability could go anywhere".
//
// v1 ships two sets:
//   CLASSIC   the vanilla heavies (heavy / uppercutH / hammerfist), free.
//   POWER-UP  copies of the J moves dealing heavy-tier damage for lots of
//             energy, plus FURY: a duration ability (+25% damage on all
//             attacks for 10s) that drains energy.
// A future SWORD set plugs into LOADOUT_DEFS with no other code changes.
//
// The menu opens on E or I and HARD-PAUSES the scene (scene.pause: the fixed
// step stops entirely — no sim, no render churn; DOM overlay on top). E is
// only bound when the roguelike StyleManager is absent (E = IMBUE there);
// I always works. The roguelike mode keeps its own power economy untouched.
//
// Energy: its own pool (the style energy bar is a separate system). Bar +
// buff timer draw under the P1 health bar. Persistence: equipped ids in
// localStorage 'stickfight.loadout'; energy is per-life-session.
// ============================================================================

const LOADOUT_T = {
  energyMax: 100,
  energyStart: 60,
  // NO time-based regen (user: "I want avoiding engagement to be
  // disadvantageous") — energy is earned ONLY by landing hits and kills.
  energyPerHit: 2,      // player attack lands
  energyPerKill: 12,
  buffCost: 25,         // FURY activation
  buffDrain: 4,         // energy/s while the buff runs (empty bar ends it)
  buffFrames: 600,      // 10s
  buffMult: 1.25,       // "slightly more damage"
};

// id -> definition. Attacks copy an existing CFG.attacks entry (frame data,
// pose, hitbox — the animation-never-touches-hitboxes law means copies are
// honest here); abilities are instant effects, no attack start.
const LOADOUT_DEFS = [
  // CLASSIC set (the default loadout, byte-identical to vanilla heavies)
  { id: 'heavy',      set: 'CLASSIC', name: 'HEAVY',          dir: 'neutral', cfg: 'heavy' },
  { id: 'uppercutH',  set: 'CLASSIC', name: 'HEAVY UPPERCUT', dir: 'up',      cfg: 'uppercutH' },
  { id: 'hammerfist', set: 'CLASSIC', name: 'HAMMERFIST',     dir: 'down',    cfg: 'hammerfist' },
  // POWER-UP set (user spec: "copies of the J moves that deal as much damage
  // as the heavy moves but cost lots of energy" + a duration buff)
  { id: 'powerJab',   set: 'POWER-UP', name: 'POWER JAB',      dir: 'neutral', cfg: 'lo_powerJab',   energy: 30 },
  { id: 'powerUpper', set: 'POWER-UP', name: 'POWER UPPERCUT', dir: 'up',      cfg: 'lo_powerUpper', energy: 30 },
  { id: 'powerSweep', set: 'POWER-UP', name: 'POWER SWEEP',    dir: 'down',    cfg: 'lo_powerSweep', energy: 30 },
  { id: 'fury',       set: 'POWER-UP', name: 'FURY  10s +25% DMG', dir: 'none', kind: 'ability', energy: LOADOUT_T.buffCost },
];

const LOADOUT_SLOTS = ['neutral', 'up', 'down'];
const SLOT_LABEL = { neutral: 'K', up: 'W+K', down: 'S+K' };

class LoadoutManager {
  constructor(scene) {
    this.scene = scene;
    this.energy = LOADOUT_T.energyStart;
    this.buffT = 0;                   // FURY frames remaining
    this.open = false;
    this.flash = ''; this.flashT = 0; // e.g. 'LOW ENERGY' blip
    // Equip: slot -> def id. Load saved build (validated against defs).
    this.equip = { neutral: 'heavy', up: 'uppercutH', down: 'hammerfist' };
    try {
      const saved = JSON.parse(localStorage.getItem('stickfight.loadout') || '{}');
      for (const s of LOADOUT_SLOTS) {
        const d = LOADOUT_DEFS.find((x) => x.id === saved[s]);
        if (d && (d.dir === s || d.dir === 'none')) this.equip[s] = d.id;
      }
    } catch (e) { /* private mode: defaults */ }
    this._injectMoves();
  }

  // POWER-UP copies ride the ORIGINAL J-move frame data (user: "copies of the
  // J moves") with heavy-tier damage — the energy cost is the balance lever,
  // not the frames. Non-chaining: a heavy slot is a committed single move.
  _injectMoves() {
    // Classic scripts share one global lexical scope: CFG (fighter.js const)
    // is directly visible here even though window.CFG is undefined.
    if (typeof CFG !== 'undefined' && CFG.attacks && !CFG.attacks.lo_powerJab) {
      const copy = (base, over) => Object.assign({}, CFG.attacks[base], over, { chain: false });
      CFG.attacks.lo_powerJab   = copy('jab1',     { damage: 14, loCost: 30 });
      CFG.attacks.lo_powerUpper = copy('uppercut', { damage: 12, loCost: 30 });
      CFG.attacks.lo_powerSweep = copy('sweep',    { damage: 14, loCost: 30 });
    }
  }

  def(id) { return LOADOUT_DEFS.find((d) => d.id === id) || null; }

  // ---- Fighter integration -------------------------------------------------
  // Heavy press landed on a grounded player slot. Returns the CFG attack key,
  // or null to fall through to vanilla (p2, air, katana, missing set).
  // Abilities activate HERE and return null (the press is spent on the spell).
  selectFor(slot, p1) {
    const d = this.def(this.equip[slot]);
    if (!d) return null;
    if (d.kind === 'ability') { this.tryActivate(d); return null; }
    const cost = d.energy || 0;
    if (this.energy < cost) { this.setFlash('LOW ENERGY — ' + d.name + ' (' + cost + ')'); return null; }
    return d.cfg;
  }

  // Called from Fighter.startAttack so the SPEND rides the commit (selectFor
  // can be polled from several gates without double-charging).
  spendFor(cfgKey) {
    const d = LOADOUT_DEFS.find((x) => x.cfg === cfgKey);
    if (d && d.energy) { this.energy = Math.max(0, this.energy - d.energy); this._menuEnergy(); }
  }

  tryActivate(d) {
    if (this.buffT > 0) return;                       // already raging; no refresh
    if (this.energy < d.energy) { this.setFlash('LOW ENERGY — ' + d.name + ' (' + d.energy + ')'); return; }
    this.energy -= d.energy;
    this.buffT = LOADOUT_T.buffFrames;
    if (this.scene.p1) this.scene.p1.loadoutDmgMult = LOADOUT_T.buffMult;
    this.setFlash('FURY!');
    this._menuEnergy();
  }

  tick() {
    const T = LOADOUT_T;
    if (this.buffT > 0) {
      this.buffT--;
      this.energy = Math.max(0, this.energy - T.buffDrain / 60);
      if (this.energy <= 0) this.buffT = 0;           // bar dry: buff ends early
      if (this.scene.p1) this.scene.p1.loadoutDmgMult = LOADOUT_T.buffMult;
      if (this.buffT === 0 && this.scene.p1) this.scene.p1.loadoutDmgMult = 1;
    }
    if (this.flashT > 0) this.flashT--;
  }

  onPlayerHit() { this.energy = Math.min(LOADOUT_T.energyMax, this.energy + LOADOUT_T.energyPerHit); }
  onKill(attacker) {
    if (attacker === this.scene.p1) this.energy = Math.min(LOADOUT_T.energyMax, this.energy + LOADOUT_T.energyPerKill);
  }

  setFlash(msg) { this.flash = msg; this.flashT = 100; }

  // ---- MENU (pause overlay) ------------------------------------------------
  initMenu() {
    if (document.getElementById('lo-menu')) return;
    const st = document.createElement('style');
    st.textContent = `
      #lo-menu{position:fixed;inset:0;display:none;align-items:center;justify-content:center;
        background:rgba(5,6,12,.74);z-index:60;font-family:monospace;color:#cdd6f4;}
      #lo-menu .lo-card{width:540px;background:#101423;border:1px solid #2a3a63;border-radius:12px;
        padding:22px 26px;box-shadow:0 0 40px rgba(0,0,0,.6);}
      #lo-menu .lo-head{display:flex;justify-content:space-between;font-size:18px;letter-spacing:3px;margin-bottom:4px;}
      #lo-menu .lo-energy{color:#5fd6c4;font-size:13px;margin-bottom:14px;}
      #lo-menu .lo-row{display:flex;align-items:center;gap:12px;padding:10px 12px;margin:6px 0;
        border:1px solid #24304f;border-radius:8px;cursor:pointer;background:#0d1220;}
      #lo-menu .lo-row:hover{border-color:#4a63a8;}
      #lo-menu .lo-key{color:#f2b705;font-size:12px;min-width:44px;}
      #lo-menu .lo-name{flex:1;font-size:15px;}
      #lo-menu .lo-tag{font-size:11px;color:#8fa1d9;}
      #lo-menu .lo-foot{margin-top:14px;font-size:11px;color:#5b6a94;}
      #lo-menu .lo-resume{margin-top:12px;width:100%;padding:8px;background:#182238;color:#cdd6f4;
        border:1px solid #2a3a63;border-radius:8px;font-family:inherit;font-size:13px;letter-spacing:2px;cursor:pointer;}
      #lo-menu .lo-resume:hover{border-color:#4a63a8;}`;
    document.head.appendChild(st);
    const menu = document.createElement('div');
    menu.id = 'lo-menu';
    menu.innerHTML =
      '<div class="lo-card">' +
      '  <div class="lo-head"><span>LOADOUT</span><span id="lo-pts"></span></div>' +
      '  <div class="lo-energy" id="lo-energy"></div>' +
      LOADOUT_SLOTS.map((s, i) =>
        '<div class="lo-row" id="lo-row-' + s + '" title="click to swap move">' +
        '  <span class="lo-key">' + (i + 1) + '  ' + SLOT_LABEL[s] + '</span>' +
        '  <span class="lo-name" id="lo-name-' + s + '"></span>' +
        '  <span class="lo-tag" id="lo-tag-' + s + '"></span></div>').join('') +
      '  <div class="lo-foot">click a row (or press 1/2/3) to cycle movesets &nbsp;·&nbsp; ' +
      'CLASSIC heavies are free &nbsp;·&nbsp; POWER-UP moves burn energy' +
      '  <br>normal J attacks, air moves and dash attacks are never swapped</div>' +
      '  <button class="lo-resume" id="lo-resume">RESUME &nbsp;(E / I / ESC)</button>' +
      '</div>';
    document.body.appendChild(menu);
    this.menuEl = menu;
    for (const s of LOADOUT_SLOTS)
      document.getElementById('lo-row-' + s).addEventListener('click', () => this.cycle(s));
    document.getElementById('lo-resume').addEventListener('click', () => this.close());
    // Number keys cycle slots while open. E/I/Esc CLOSE through here ONLY for
    // Escape (E/I close via the scene key handler — binding them twice here
    // would double-toggle). Digits aren't captured by the game, so a plain
    // window listener is safe during pause (the keyboard plugin keeps firing
    // while the scene is paused).
    window.addEventListener('keydown', (ev) => {
      if (!this.open) return;
      if (ev.repeat) return;
      // While PAUSED the scene's keyboard plugin is inactive — the DOM
      // listener here is the ONLY input path (E/I must close from here; the
      // scene handlers only ever see the OPENING press).
      const c = ev.keyCode;
      if (ev.key === '1') this.cycle('neutral');
      else if (ev.key === '2') this.cycle('up');
      else if (ev.key === '3') this.cycle('down');
      else if (ev.key === 'Escape' || ev.key === 'e' || ev.key === 'E' || ev.key === 'i' || ev.key === 'I'
               || c === 27 || c === 69 || c === 73) {
        // The OPENING E keydown bubbles here too (scene handler opened the
        // menu a microsecond ago) — ignoring presses within 300ms of opening
        // stops that same event from instantly closing it again.
        if (performance.now() - (this._openedAt || 0) < 300) return;
        this.close();
      }
    });
  }

  toggle() {
    // Debounce: keyboard 'down' can double-fire (hold-repeat) — a double
    // toggle looks like a flicker.
    const now = performance.now();
    if (now - (this._lastToggle || -1e9) < 150) return;
    this._lastToggle = now;
    this.open ? this.close() : this.show();
  }
  show() {
    if (this.open) return;
    this.open = true;
    this._openedAt = performance.now();
    this._refresh();
    this.menuEl.style.display = 'flex';
    // Phaser 4: pause lives on the ScenePlugin (scene.scene), not the scene
    // itself. update() stops => the fixed-step accumulator stops => hard freeze.
    this.scene.scene.pause();
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.menuEl.style.display = 'none';
    this.scene.scene.resume();
  }

  cycle(slot) {
    // Pool = every def whose direction allows this slot ('none' fits any).
    const pool = LOADOUT_DEFS.filter((d) => d.dir === slot || d.dir === 'none');
    const i = pool.findIndex((d) => d.id === this.equip[slot]);
    this.equip[slot] = pool[(i + 1) % pool.length].id;
    try { localStorage.setItem('stickfight.loadout', JSON.stringify(this.equip)); }
    catch (e) { /* private mode */ }
    this._refresh();
  }

  _refresh() {
    this._menuEnergy();
    for (const s of LOADOUT_SLOTS) {
      const d = this.def(this.equip[s]);
      document.getElementById('lo-name-' + s).textContent = d ? d.name : '???';
      document.getElementById('lo-tag-' + s).textContent =
        d ? d.set + '  ·  ' + (d.energy ? d.energy + ' ENERGY' : 'FREE')
          + (d.dir === 'none' ? '  ·  ANY DIRECTION' : '') : '';
    }
  }
  _menuEnergy() {
    const el = document.getElementById('lo-energy');
    if (el) el.textContent = 'ENERGY  ' + Math.round(this.energy) + ' / ' + LOADOUT_T.energyMax +
      (this.buffT > 0 ? '    FURY ' + (this.buffT / 60).toFixed(1) + 's' : '');
  }
}

window.LOADOUT_T = LOADOUT_T;
window.LOADOUT_DEFS = LOADOUT_DEFS;
window.LoadoutManager = LoadoutManager;
