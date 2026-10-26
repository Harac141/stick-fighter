// ============================================================================
// LOADOUT MANAGER — swappable attacks + energy economy (base brawler).
//
// Design (user brief, Oct 2026, v2): "let's have two powers, one per hand...
// you could have a sword in one hand and, say, time stop in the other...
// swap moves for both keys, and either one could have heavy or light
// attacks." Six slots: J / W+J / S+J (LEFT HAND column) and K / W+K / S+K
// (RIGHT HAND column). Every move declares only a DIRECTION binding
// ('neutral' | 'up' | 'down' | 'none'); 'none' fits ANY slot — that's where
// duration/trigger powers (the future time-stop) will live. A slot cares only
// about the pressed key+modifier, never whether its move is heavy- or
// light-tier: any move fits either key. The hand ITEM art (which glove holds
// the sword/whatnot) is deliberately deferred — "you can't really tell which
// hand is doing the attack so just switch the items in the hands... later".
//
// FURY (10s +25% buff) was REMOVED (user testing: "doesn't really do enough
// to be worth a move slot"). The ability SCAFFOLD (kind:'ability',
// tryActivate) stays dormant for the time-stop plan.
//
// Sets: CLASSIC = the vanilla moveset (free, byte-identical frame data —
// including the J chain, which the 'jab' def passes through to Fighter's
// vanilla chain logic via the LOADOUT_VANILLA sentinel). POWER-UP = copies of
// the J moves with heavy-tier damage for energy (user v1 spec, now
// equippable on EITHER key).
//
// The menu opens on E or I and HARD-PAUSES the scene. While paused the
// scene's keyboard plugin is dead, so ONE module-level DOM listener (bound
// once, delegating through window.__loActive — scene.restart() recreates
// managers and per-init listeners would stack) owns all menu input. Roguelike
// ?style=1 excludes this system entirely (E is IMBUE there; its own energy
// pool stays).
//
// Energy (own pool): earned ONLY through combat — +2 per landed hit, +12 per
// kill. NO time regen (user: "avoiding engagement must be disadvantageous").
// Equips persist in localStorage 'stickfight.loadout' (legacy 3-slot saves
// migrate into the K column).
// ============================================================================

const LOADOUT_T = {
  energyMax: 100,
  energyStart: 60,
  // NO time-based regen (user: "I want avoiding engagement to be
  // disadvantageous") — energy is earned ONLY by landing hits and kills.
  energyPerHit: 2,      // player attack lands
  energyPerKill: 12,
  // Dormant ability scaffold (Fury removed; a future time-stop will reuse):
  buffCost: 25, buffDrain: 4, buffFrames: 600, buffMult: 1.25,
};

// id -> definition. Attacks copy an existing CFG.attacks entry (frame data,
// pose, hitbox — the animation-never-touches-hitboxes law means copies are
// honest here); abilities are instant effects, no attack start.
const LOADOUT_DEFS = [
  // CLASSIC set — the default loadout, byte-identical to vanilla.
  // 'jab' is vanilla-marked: the J press falls through to Fighter's chain
  // machinery (pop-pop + J-J-K heavy cancel), which only selectAttack's
  // tail knows how to run.
  { id: 'jab',        set: 'CLASSIC', name: 'JAB STRING',      dir: 'neutral', cfg: 'jab1', vanilla: true },
  { id: 'uppercut',   set: 'CLASSIC', name: 'UPPERCUT',        dir: 'up',      cfg: 'uppercut' },
  { id: 'sweep',      set: 'CLASSIC', name: 'SWEEP',           dir: 'down',    cfg: 'sweep' },
  { id: 'heavy',      set: 'CLASSIC', name: 'HEAVY',           dir: 'neutral', cfg: 'heavy' },
  { id: 'uppercutH',  set: 'CLASSIC', name: 'HEAVY UPPERCUT',  dir: 'up',      cfg: 'uppercutH' },
  { id: 'hammerfist', set: 'CLASSIC', name: 'HAMMERFIST',      dir: 'down',    cfg: 'hammerfist' },
  // POWER-UP set (user spec): "copies of the J moves that deal as much
  // damage as the heavy moves but cost lots of energy". Either key.
  { id: 'powerJab',   set: 'POWER-UP', name: 'POWER JAB',      dir: 'neutral', cfg: 'lo_powerJab',   energy: 30 },
  { id: 'powerUpper', set: 'POWER-UP', name: 'POWER UPPERCUT', dir: 'up',      cfg: 'lo_powerUpper', energy: 30 },
  { id: 'powerSweep', set: 'POWER-UP', name: 'POWER SWEEP',    dir: 'down',    cfg: 'lo_powerSweep', energy: 30 },
];

// Slot ids are '<KEY>_<dir>'. The KEY half is which attack button feeds the
// slot; the dir half matches a move's binding. Columns mirror the hand
// fantasy (J = left/light, K = right/heavy) but tier is the MOVE's business:
// any def can sit on either key.
const LOADOUT_SLOTS = ['J_neutral', 'J_up', 'J_down', 'K_neutral', 'K_up', 'K_down'];
const SLOT_LABEL = { J_neutral: 'J', J_up: 'W+J', J_down: 'S+J',
                     K_neutral: 'K', K_up: 'W+K', K_down: 'S+K' };
const LOADOUT_DEFAULTS = { J_neutral: 'jab', J_up: 'uppercut', J_down: 'sweep',
                           K_neutral: 'heavy', K_up: 'uppercutH', K_down: 'hammerfist' };
// selectFor() returns this sentinel when Fighter should fall through to its
// vanilla tail (the classic jab: chain + heavy-cancel live there).
const LOADOUT_VANILLA = { vanilla: true };

class LoadoutManager {
  constructor(scene) {
    this.scene = scene;
    this.energy = LOADOUT_T.energyStart;
    this.buffT = 0;                   // dormant ability scaffold (see LOADOUT_T)
    this.open = false;
    this.flash = ''; this.flashT = 0; // e.g. 'LOW ENERGY' blip
    // Equip: slot id -> def id. Load saved build (validated against defs);
    // migrate the legacy 3-slot (K-only, keys 'neutral'/'up'/'down') save
    // format into the K column.
    this.equip = Object.assign({}, LOADOUT_DEFAULTS);
    try {
      const saved = JSON.parse(localStorage.getItem('stickfight.loadout') || '{}');
      const migrated = {};
      for (const s of LOADOUT_SLOTS) {
        migrated[s] = saved[s] || (s.startsWith('K_') ? saved[s.split('_')[1]] : null) || null;
      }
      for (const s of LOADOUT_SLOTS) {
        const d = LOADOUT_DEFS.find((x) => x.id === migrated[s]);
        if (d && (d.dir === s.split('_')[1] || d.dir === 'none')) this.equip[s] = d.id;
      }
    } catch (e) { /* private mode: defaults */ }
    this.sel = 'K_neutral';           // menu slot selection
    this.cursor = 0;                  // pool cursor
    this._injectMoves();
    window.__loActive = this;         // the one menu key handler drives
  }

  // POWER-UP copies ride the ORIGINAL J-move frame data (user: "copies of the
  // J moves") with heavy-tier damage — the energy cost is the balance lever,
  // not the frames. Non-chaining: a swapped move is a committed single hit
  // (equipping it on J trades your jab string for it — a build decision).
  _injectMoves() {
    // Classic scripts share one global lexical scope: CFG (fighter.js const)
    // is directly visible here even though window.CFG is undefined.
    if (typeof CFG !== 'undefined' && CFG.attacks && !CFG.attacks.lo_powerJab) {
      const copy = (base, over) => Object.assign({}, CFG.attacks[base], over, { chain: false });
      // fx:'energy' marks the POWER-UP moves for the effect layer (red
      // swipes/sparks vs white) — pure presentation, never frame data.
      CFG.attacks.lo_powerJab   = copy('jab1',     { damage: 14, loCost: 30, fx: 'energy' });
      CFG.attacks.lo_powerUpper = copy('uppercut', { damage: 12, loCost: 30, fx: 'energy' });
      CFG.attacks.lo_powerSweep = copy('sweep',    { damage: 14, loCost: 30, fx: 'energy' });
    }
  }

  def(id) { return LOADOUT_DEFS.find((d) => d.id === id) || null; }

  // ---- Fighter integration -------------------------------------------------
  // A player attack press landed on a slot. Returns the CFG attack key,
  // LOADOUT_VANILLA to fall through to Fighter's tail, or null to spend the
  // press with no attack (unaffordable / ability fired).
  selectFor(slotId, p1) {
    const d = this.def(this.equip[slotId]);
    if (!d) return null;
    if (d.vanilla) return LOADOUT_VANILLA;
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

  // Dormant ability path (Fury removed; time-stop will use this shape).
  tryActivate(d) {
    if (this.buffT > 0) return;                       // already active; no refresh
    if (this.energy < d.energy) { this.setFlash('LOW ENERGY — ' + d.name + ' (' + d.energy + ')'); return; }
    this.energy -= d.energy;
    this.buffT = LOADOUT_T.buffFrames;
    if (this.scene.p1) this.scene.p1.loadoutDmgMult = LOADOUT_T.buffMult;
    this.setFlash(d.name + '!');
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

  // ---- MENU (pause overlay) -------------------------------------------------
  // Picker layout: six slot rows (two hand-columns) + a pool panel listing
  // every move compatible with the selected slot. Scales to a large move pool
  // (the old click-to-cycle rows did not). Mouse-first; 1-6 select a slot,
  // arrows + Enter pick from the pool.
  initMenu() {
    if (!document.getElementById('lo-menu-style')) {
      const st = document.createElement('style');
      st.id = 'lo-menu-style';
      st.textContent = `
        #lo-menu{position:fixed;inset:0;display:none;align-items:center;justify-content:center;
          background:rgba(5,6,12,.74);z-index:60;font-family:monospace;color:#cdd6f4;}
        #lo-menu .lo-card{width:720px;max-width:94vw;background:#101423;border:1px solid #2a3a63;
          border-radius:12px;padding:20px 24px;box-shadow:0 0 40px rgba(0,0,0,.6);}
        #lo-menu .lo-head{display:flex;justify-content:space-between;font-size:18px;letter-spacing:3px;}
        #lo-menu .lo-sub{color:#5b6a94;font-size:11px;margin:2px 0 10px;letter-spacing:1px;}
        #lo-menu .lo-energy{color:#5fd6c4;font-size:13px;margin-bottom:12px;}
        #lo-menu .lo-body{display:flex;gap:16px;}
        #lo-menu .lo-col{flex:0 0 216px;}
        #lo-menu .lo-colh{font-size:11px;letter-spacing:2px;color:#8fa1d9;margin:2px 0 6px;}
        #lo-menu .lo-row{display:flex;align-items:center;gap:10px;padding:8px 10px;margin:5px 0;
          border:1px solid #24304f;border-radius:8px;cursor:pointer;background:#0d1220;}
        #lo-menu .lo-row:hover{border-color:#4a63a8;}
        #lo-menu .lo-row.sel{border-color:#f2b705;background:#151b2e;}
        #lo-menu .lo-key{color:#f2b705;font-size:12px;min-width:40px;}
        #lo-menu .lo-name{flex:1;font-size:14px;}
        #lo-menu .lo-tag{font-size:10px;color:#8fa1d9;text-align:right;}
        #lo-menu .lo-poolwrap{flex:1;border-left:1px solid #24304f;padding-left:16px;min-width:0;}
        #lo-menu #lo-pool{max-height:196px;overflow-y:auto;}
        #lo-menu .lo-opt{display:flex;align-items:center;gap:10px;padding:7px 10px;margin:4px 0;
          border:1px solid transparent;border-radius:8px;cursor:pointer;}
        #lo-menu .lo-opt:hover{background:#141a2c;}
        #lo-menu .lo-opt.cur{border-color:#4a63a8;background:#141a2c;}
        #lo-menu .lo-opt.eq{outline:1px solid #3fd6b6;}
        #lo-menu .lo-foot{margin-top:12px;font-size:10px;color:#5b6a94;}
        #lo-menu .lo-resume{margin-top:10px;width:100%;padding:8px;background:#182238;color:#cdd6f4;
          border:1px solid #2a3a63;border-radius:8px;font-family:inherit;font-size:13px;letter-spacing:2px;cursor:pointer;}
        #lo-menu .lo-resume:hover{border-color:#4a63a8;}`;
      document.head.appendChild(st);
      const menu = document.createElement('div');
      menu.id = 'lo-menu';
      menu.innerHTML =
        '<div class="lo-card">' +
        '  <div class="lo-head"><span>LOADOUT</span></div>' +
        '  <div class="lo-sub">TWO POWERS, ONE PER HAND — equip any move on any attack slot; tier is the move\u2019s business, not the hand\u2019s</div>' +
        '  <div class="lo-energy" id="lo-energy"></div>' +
        '  <div class="lo-body">' +
             ['J', 'K'].map((key) =>
               '<div class="lo-col"><div class="lo-colh">' +
               (key === 'J' ? 'LEFT HAND \u00b7 LIGHT' : 'RIGHT HAND \u00b7 HEAVY') + '</div>' +
               LOADOUT_SLOTS.filter((s) => s.startsWith(key)).map((s) =>
                 '<div class="lo-row" data-slot="' + s + '">' +
                 '  <span class="lo-key">' + SLOT_LABEL[s] + '</span>' +
                 '  <span class="lo-name" id="lo-name-' + s + '"></span>' +
                 '  <span class="lo-tag" id="lo-tag-' + s + '"></span></div>').join('') +
               '</div>').join('') +
        '    <div class="lo-poolwrap"><div class="lo-colh">CHOOSE \u2014 <span id="lo-pool-key"></span></div>' +
        '      <div id="lo-pool"></div></div>' +
        '  </div>' +
        '  <div class="lo-foot">click a slot then a move \u00b7 1-6 select slot \u00b7 \u2191\u2193 + Enter pick \u00b7 ESC / E / I resume \u00b7' +
        ' air & dash attacks never swap \u00b7 CLASSIC = free, POWER-UP burns energy (earned by fighting)</div>' +
        '  <button class="lo-resume" id="lo-resume">RESUME \u00a0(E / I / ESC)</button>' +
        '</div>';
      document.body.appendChild(menu);
      // ONE listener for the module (scene.restart() recreates managers; per-
      // init listeners would stack and double-equip). Delegates to the live
      // manager via window.__loActive.
      if (!window.__loKeyBound) {
        window.__loKeyBound = true;
        window.addEventListener('keydown', (ev) => {
          const m = window.__loActive;
          if (m && m.open) m._menuKey(ev);
        });
      }
      // Click delegation (same single-listener reason).
      menu.addEventListener('click', (ev) => {
        const m = window.__loActive; if (!m || !m.open) return;
        const row = ev.target.closest('.lo-row');
        if (row) { m.select(row.dataset.slot); return; }
        const opt = ev.target.closest('.lo-opt');
        if (opt) { m.equipDef(opt.dataset.def); return; }
        if (ev.target.closest('.lo-resume')) m.close();
      });
    }
    this.menuEl = document.getElementById('lo-menu');
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

  select(slotId) {
    if (LOADOUT_SLOTS.indexOf(slotId) < 0) return;
    this.sel = slotId;
    this.cursor = 0;
    this._refresh();
  }

  // (Method name is equipDef, NOT equip: the instance field this.equip —
  // slot -> def id map — would shadow a prototype method of the same name,
  // making menu clicks / Enter silently throw.)
  equipDef(defId) {
    const dir = this.sel.split('_')[1];
    const d = LOADOUT_DEFS.find((x) => x.id === defId && (x.dir === dir || x.dir === 'none'));
    if (!d) return;
    this.equip[this.sel] = d.id;
    try { localStorage.setItem('stickfight.loadout', JSON.stringify(this.equip)); }
    catch (e) { /* private mode */ }
    this._refresh();
  }

  // Keys while PAUSED: the scene keyboard plugin is dead — this listener (via
  // the module delegate) is the only input path. E/I/Esc close from here; the
  // scene handlers only ever see the OPENING press.
  _menuKey(ev) {
    if (ev.repeat) return;
    const k = ev.key, c = ev.keyCode;
    const n = Number(k);
    if (n >= 1 && n <= LOADOUT_SLOTS.length) { this.select(LOADOUT_SLOTS[n - 1]); return; }
    if (k === 'ArrowDown') { this.cursor++; this._renderPool(); return; }
    if (k === 'ArrowUp')   { this.cursor--; this._renderPool(); return; }
    if (k === 'Enter' || k === ' ') {
      const p = this._pool();
      if (p[this.cursor]) this.equipDef(p[this.cursor].id);
      return;
    }
    if (k === 'Escape' || k === 'e' || k === 'E' || k === 'i' || k === 'I'
        || c === 27 || c === 69 || c === 73) {
      // The OPENING E keydown bubbles here too (scene handler opened the
      // menu a microsecond ago) — ignoring presses within 300ms of opening
      // stops that same event from instantly closing it again.
      if (performance.now() - (this._openedAt || 0) < 300) return;
      this.close();
    }
  }

  _pool() {
    const dir = this.sel.split('_')[1];
    return LOADOUT_DEFS.filter((d) => d.dir === dir || d.dir === 'none');
  }

  _refresh() {
    this._menuEnergy();
    for (const s of LOADOUT_SLOTS) {
      const d = this.def(this.equip[s]);
      document.getElementById('lo-name-' + s).textContent = d ? d.name : '???';
      document.getElementById('lo-tag-' + s).textContent =
        d ? d.set + '  \u00b7  ' + (d.energy ? d.energy + ' ENERGY' : 'FREE') : '';
      document.querySelector('.lo-row[data-slot="' + s + '"]').classList.toggle('sel', s === this.sel);
    }
    const keyEl = document.getElementById('lo-pool-key');
    if (keyEl) keyEl.textContent = SLOT_LABEL[this.sel] + ' \u2014 ' + (this.sel.startsWith('J') ? 'left hand' : 'right hand');
    this._renderPool();
  }

  _renderPool() {
    const wrap = document.getElementById('lo-pool');
    if (!wrap) return;
    const pool = this._pool();
    this.cursor = Math.min(Math.max(this.cursor, 0), pool.length - 1);
    wrap.innerHTML = pool.map((d, i) =>
      '<div class="lo-opt' + (i === this.cursor ? ' cur' : '') +
      (this.equip[this.sel] === d.id ? ' eq' : '') + '" data-def="' + d.id + '">' +
      '  <span class="lo-name">' + d.name + '</span>' +
      '  <span class="lo-tag">' + d.set + ' \u00b7 ' + (d.energy ? d.energy + ' ENERGY' : 'FREE') +
      (d.dir === 'none' ? ' \u00b7 ANY SLOT' : '') + '</span></div>').join('');
  }

  _menuEnergy() {
    const el = document.getElementById('lo-energy');
    if (el) el.textContent = 'ENERGY  ' + Math.round(this.energy) + ' / ' + LOADOUT_T.energyMax;
  }
}

window.LOADOUT_T = LOADOUT_T;
window.LOADOUT_DEFS = LOADOUT_DEFS;
window.LOADOUT_SLOTS = LOADOUT_SLOTS;
window.LOADOUT_VANILLA = LOADOUT_VANILLA;
window.LoadoutManager = LoadoutManager;
