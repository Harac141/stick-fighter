// editor.js — standalone map editor for Stick Fight (editor.html).
// Edits the EXACT window.LEVELS shape (see js/levels.js header) and saves to
// localStorage under 'stickfight.customLevels' ({name: levelData}), which
// index.html (menu cards) and main.js (loadLevel) both read. No game code is
// loaded here — only levels.js for templates — so the editor boots instantly
// and can never crash on game changes.
//
// World coords match the game: groundY 620; blocks {x,w,y,h} with y = top
// height above ground (negative) and h = thickness downward; legacy pillars
// {x,w,y} still edit (solid columns — kept as-is so old maps keep their look).
//
//   sy = wy*zoom + (540 - 620*zoom)   (ground pinned at cy 540: zoom never
//                                      moves the floor)
(function () {
  'use strict';
  const GROUND = 620, CY = 540, CW = 1280, CH = 560;
  const LS_KEY = 'stickfight.customLevels';
  const SKIES = [
    { id: 'night', name: 'NIGHT', sky: [0x101423, 0x1b2440] },
    { id: 'dusk', name: 'DUSK', sky: [0x141a2e, 0x33284e] },
    { id: 'dock', name: 'DOCK', sky: [0x121826, 0x223048] },
    { id: 'blood', name: 'BLOOD', sky: [0x23101a, 0x4a1f2c] },
    { id: 'void', name: 'VOID', sky: [0x05060a, 0x101423] },
    { id: 'sage', name: 'SAGE', sky: [0x0f1f1c, 0x1f3d33] },
  ];

  // ---- Editor document = a level object in registry shape ----
  function blank() {
    return {
      desc: 'A fresh arena.', width: 2600,
      sky: SKIES[0].sky.slice(), p1x: 200, respawnX: 160,
      floors: [{ x: 0, w: 2600 }],   // one continuous slab (pits dormant)
      pillars: [], blocks: [], spawns: [],
    };
  }

  let doc = blank();
  // Any map entering `doc` from outside (localStorage via ?edit=/templates,
  // hand-edited or older saves) is normalized: draw() reads sky/floors
  // unguarded, and one throw inside the rAF loop kills the editor canvas
  // permanently (observed: a sky-less hand-seeded map = blank editor).
  function normalize(d) {
    d.width = Math.max(1280, Math.min(8192, Number(d.width) || 2600));
    if (!Array.isArray(d.sky) || d.sky.length !== 2 || d.sky.some((n) => !Number.isFinite(n)))
      d.sky = SKIES[0].sky.slice();
    if (!Number.isFinite(d.p1x)) d.p1x = 200;
    if (!Number.isFinite(d.respawnX)) d.respawnX = 160;
    if (!Array.isArray(d.floors) || !d.floors.length) d.floors = [{ x: 0, w: d.width }];
    if (!Array.isArray(d.pillars)) d.pillars = [];
    if (!Array.isArray(d.blocks)) d.blocks = [];
    if (!Array.isArray(d.spawns)) d.spawns = [];
    return d;
  }
  let tool = 'select';
  let sel = null;              // {kind:'pillar'|'block'|'spawn'|'p1', i}
  let camX = 1300, zoom = 1;   // view centre (world px) / zoom
  let ghost = null;            // create preview {kind, x0,y0,x1?,y1?}
  const undoStack = [];

  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const statusEl = document.getElementById('status');
  const propsEl = document.getElementById('props');
  const nameEl = document.getElementById('f-name');
  const descEl = document.getElementById('f-desc');
  const widthEl = document.getElementById('f-width');
  const skyEl = document.getElementById('f-sky');

  const loadLS = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } };
  const saveLS = (all) => localStorage.setItem(LS_KEY, JSON.stringify(all));
  const snap = () => { undoStack.push(JSON.stringify(doc)); if (undoStack.length > 60) undoStack.shift(); };
  const undo = () => { if (!undoStack.length) return; doc = JSON.parse(undoStack.pop()); sel = null; syncFields(); drawProps(); status('undo'); };
  const status = (m, bad) => { statusEl.textContent = m; statusEl.style.color = bad ? '#ff7a7a' : '#8fe08f'; };

  const sx = (wx) => (wx - camX) * zoom + CW / 2;
  const sy = (wy) => wy * zoom + (CY - GROUND * zoom);
  const wx = (px) => (px - CW / 2) / zoom + camX;
  const wy = (py) => (py - (CY - GROUND * zoom)) / zoom;
  const snapG = (v) => Math.round(v / 10) * 10;

  // ---- geometry helpers ----
  // Pinned spawns reference EITHER legacy pillars[] or blocks[]; block
  // indices are RAW (the loader offsets past legacy pillars at boot).
  const pinObj = (sp) => sp.block != null ? doc.blocks[sp.block]
                     : sp.pillar != null ? doc.pillars[sp.pillar] : null;
  const effX = (sp) => { const o = pinObj(sp); return o ? o.x + o.w / 2 : sp.x; };
  const objTop = (o) => GROUND + (o.y || 0);
  const objBottom = (o) => Math.min(GROUND, GROUND + (o.y || 0) + Math.max(30, Number(o.h) || -(o.y || 0)));
  const spawnY = (sp) => { const o = pinObj(sp); return o ? objTop(o) : GROUND; };
  const spawnType = (sp) => (sp.knobs && sp.knobs.weapon) ? 'gunner'
    : (sp.knobs && sp.knobs.hp > 12) ? 'elite' : 'mook';
  const TYPE_KNOBS = {
    mook: () => ({}),
    elite: () => ({ hp: 24, aggression: 1.6 }),
    gunner: () => ({ weapon: 'pistol' }),
  };
  const TYPE_COUNT = { mook: 4, elite: 2, gunner: 1 };
  const TYPE_COLOR = { mook: '#ff8f5a', elite: '#ffd166', gunner: '#ffe066' };

  // Hit tests in screen space (topmost first: handles > spawns > p1 > block > pillar).
  function pick(mx, my) {
    // resize handles on a selected block/pillar
    if (sel && (sel.kind === 'block' || sel.kind === 'pillar')) {
      const o = sel.kind === 'block' ? doc.blocks[sel.i] : doc.pillars[sel.i];
      if (o) {
        const top = objTop(o), bot = objBottom(o);
        const hx = sx(o.x + o.w), hy = sy((top + bot) / 2);
        if (Math.hypot(mx - hx, my - hy) < 9) return { kind: 'handle-w', selKind: sel.kind, i: sel.i };
        const tx = sx(o.x + o.w / 2), ty = sy(top);
        if (Math.hypot(mx - tx, my - ty) < 9) return { kind: 'handle-h', selKind: sel.kind, i: sel.i };
        if (sel.kind === 'block') {
          const by = sy(bot);
          if (Math.hypot(mx - tx, my - by) < 9) return { kind: 'handle-thick', selKind: 'block', i: sel.i };
        }
      }
    }
    for (let i = doc.spawns.length - 1; i >= 0; i--) {
      const sp = doc.spawns[i];
      const px = sx(effX(sp)), py = sy(spawnY(sp));
      // Hit box covers the true-scale row of figures (bodies stand 92px up).
      const halfRow = ((sp.count - 1) * 56 / 2 + 16) * zoom;
      if (Math.abs(mx - px) < halfRow && my < py + 6 && my > py - 100 * zoom)
        return { kind: 'spawn', i };
    }
    {
      const px = sx(doc.p1x), py = sy(GROUND);
      if (Math.abs(mx - px) < 20 * zoom + 4 && my < py + 6 && my > py - 92 * zoom)
        return { kind: 'p1' };
    }
    for (let i = doc.blocks.length - 1; i >= 0; i--) {
      const b = doc.blocks[i];
      if (mx >= sx(b.x) && mx <= sx(b.x + b.w) && my >= sy(objTop(b)) && my <= sy(objBottom(b)))
        return { kind: 'block', i };
    }
    for (let i = doc.pillars.length - 1; i >= 0; i--) {
      const p = doc.pillars[i];
      if (mx >= sx(p.x) && mx <= sx(p.x + p.w) && my >= sy(objTop(p)) && my <= sy(GROUND))
        return { kind: 'pillar', i };
    }
    return null;
  }

  // Which solid object (block first — drawn on top) contains a world x?
  const solidAtWorld = (wpx) => {
    for (let i = doc.blocks.length - 1; i >= 0; i--) {
      const b = doc.blocks[i];
      if (wpx >= b.x && wpx <= b.x + b.w) return { kind: 'block', i };
    }
    for (let i = doc.pillars.length - 1; i >= 0; i--) {
      const p = doc.pillars[i];
      if (wpx >= p.x && wpx <= p.x + p.w) return { kind: 'pillar', i };
    }
    return null;
  };

  // ---- pointer state ----
  let panning = null;      // {mx0, camX0}
  let moving = null;       // {kind, selKind, i, grab} offsets

  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('mousedown', (e) => {
    const r = cv.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (CW / r.width);
    const my = (e.clientY - r.top) * (CH / r.height);
    if (e.button === 2 || tool === 'select' && !pick(mx, my)) {
      panning = { mx0: e.clientX, camX0: camX };
      if (e.button !== 2 && tool === 'select') { sel = null; drawProps(); }
      return;
    }
    // NB: the y corners MUST read wy(my) — an earlier cut fed wy(mx), so the
    // block's height tracked the cursor's X and everything you drew near the
    // left edge clamped to the ground (user: "snaps to the ground and I have
    // to move it up with the height setting").
    if (tool === 'pillar') { ghost = { kind: 'pillar', x0: snapG(wx(mx)), y0: snapG(wy(my)) }; return; }
    if (tool === 'block') { ghost = { kind: 'block', x0: snapG(wx(mx)), y0: snapG(wy(my)) }; return; }
    if (tool === 'erase') {
      const k = pick(mx, my);
      if (!k || k.kind.startsWith('handle')) return;
      snap();
      if (k.kind === 'spawn') doc.spawns.splice(k.i, 1);
      else if (k.kind === 'pillar') removePillar(k.i);
      else if (k.kind === 'block') removeBlock(k.i);
      sel = null; drawProps(); return;
    }
    if (tool === 'mook' || tool === 'elite' || tool === 'gunner') {
      snap();
      const wpx = snapG(wx(mx));
      const on = solidAtWorld(wpx);
      const sp = { x: wpx, count: TYPE_COUNT[tool], knobs: TYPE_KNOBS[tool]() };
      if (on) { if (on.kind === 'block') sp.block = on.i; else sp.pillar = on.i; sp.x = 0; }
      doc.spawns.push(sp);
      sel = { kind: 'spawn', i: doc.spawns.length - 1 };
      drawProps(); return;
    }
    // select tool on an object: pick + start move
    const k = pick(mx, my);
    if (!k) return;
    sel = k.kind.startsWith('handle') ? { kind: k.selKind || 'block', i: k.i } : k;
    drawProps();
    if (k.kind === 'handle-w' || k.kind === 'handle-h' || k.kind === 'handle-thick') {
      snap(); moving = { kind: k.kind, selKind: k.selKind || 'block', i: k.i };
    } else if (k.kind === 'block' || k.kind === 'pillar' || k.kind === 'spawn') {
      snap();
      const o = k.kind === 'spawn' ? { x: effX(doc.spawns[k.i]) }
              : k.kind === 'block' ? doc.blocks[k.i] : doc.pillars[k.i];
      moving = { kind: k.kind, i: k.i, grab: wx(mx) - o.x };
      if (k.kind === 'block') moving.grabY = wy(my) - objTop(doc.blocks[k.i]);
      if (k.kind === 'spawn' && (doc.spawns[k.i].block != null || doc.spawns[k.i].pillar != null)) {
        doc.spawns[k.i].block = null; doc.spawns[k.i].pillar = null;  // unpinned drag follows x
      }
    } else if (k.kind === 'p1') { snap(); moving = { kind: 'p1', grab: wx(mx) - doc.p1x }; }
  });
  addEventListener('mousemove', (e) => {
    const r = cv.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (CW / r.width);
    const my = (e.clientY - r.top) * (CH / r.height);
    if (panning) { camX = panning.camX0 - ((e.clientX - r.left) - panning.mx0) * (CW / r.width) / zoom; return; }
    if (ghost) { ghost.x1 = snapG(wx(mx)); ghost.y1 = snapG(wy(my)); return; }
    if (!moving) return;
    const W = Number(widthEl.value) || doc.width;
    if (moving.kind === 'p1') {
      doc.p1x = Math.max(40, Math.min(W - 40, snapG(wx(mx) - moving.grab)));
    } else if (moving.kind === 'handle-w') {
      const o = moving.selKind === 'block' ? doc.blocks[moving.i] : doc.pillars[moving.i];
      o.w = Math.max(40, Math.min(1200, snapG(wx(mx) - o.x)));
    } else if (moving.kind === 'handle-h') {
      const o = moving.selKind === 'block' ? doc.blocks[moving.i] : doc.pillars[moving.i];
      const top = Math.max(-560, Math.min(-30, snapG(wy(my) - GROUND)));
      if (moving.selKind === 'block') { const bot = objBottom(o); o.y = top; o.h = Math.max(30, bot - (GROUND + top)); }
      else o.y = top;
    } else if (moving.kind === 'handle-thick') {
      const o = doc.blocks[moving.i];
      const bot = Math.max(objTop(o) + 30, Math.min(GROUND, snapG(wy(my))));
      o.h = Math.max(30, bot - objTop(o));
    } else if (moving.kind === 'block') {
      const o = doc.blocks[moving.i];
      o.x = Math.max(0, Math.min(W - o.w, snapG(wx(mx) - moving.grab)));
      // Free 2D placement — that's the whole point of blocks vs pillars.
      // The bottom rides along (thickness preserved); props re-clamp.
      // NB: wy() returns WORLD y (ground = 620), but o.y is height-above-ground
      // (negative) — subtract GROUND or every drag clamps the block into the
      // floor (user: "if I don't [raise it] it'll stay stuck in the ground").
      const top = Math.max(-560, Math.min(0, snapG(wy(my) - GROUND - moving.grabY)));
      o.h = Math.max(30, Math.min(560, objBottom(o) - (GROUND + top)));
      o.y = top;
    } else if (moving.kind === 'pillar') {
      const o = doc.pillars[moving.i];
      o.x = Math.max(0, Math.min(W - o.w, snapG(wx(mx) - moving.grab)));
    } else if (moving.kind === 'spawn') {
      doc.spawns[moving.i].x = Math.max(20, Math.min(W - 20, snapG(wx(mx) - moving.grab)));
    }
  });
  addEventListener('mouseup', () => {
    if (ghost && ghost.x1 != null) {
      const a = Math.min(ghost.x0, ghost.x1), b = Math.max(ghost.x0, ghost.x1);
      if (ghost.kind === 'block' && ghost.y1 != null) {
        // Roof/ledge/crate: any rect, both axes snapped to the 10px grid.
        // Ghost corners are WORLD y (ground=620); the doc field is height above
        // ground (negative) — the old code stored the raw world y clamped to 0,
        // so EVERY dragged block landed at/below the floor line.
        const t = Math.min(ghost.y0, ghost.y1), bo = Math.max(ghost.y0, ghost.y1);
        if (b - a >= 40 && bo - t >= 30) {
          snap();
          const y = Math.max(-560, Math.min(0, t - GROUND));        // top height above ground (neg)
          const h = Math.max(30, Math.min(560, bo - t));            // thickness downward
          doc.blocks.push({ x: Math.max(0, a), w: b - a, y, h });
          sel = { kind: 'block', i: doc.blocks.length - 1 };
          drawProps();
        }
      } else if (b - a >= 40) {
        snap();
        doc.pillars.push({ x: Math.max(0, a), w: b - a, y: -80 });
        sel = { kind: 'pillar', i: doc.pillars.length - 1 };
        drawProps();
      }
    }
    ghost = null; panning = null; moving = null;
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (CW / r.width);
    const anchor = wx(mx);
    zoom = Math.max(0.15, Math.min(2.2, zoom * Math.exp(-e.deltaY * 0.0012)));
    camX = anchor - (mx - CW / 2) / zoom;   // keep world point under cursor
  }, { passive: false });

  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!sel) return;
      snap();
      if (sel.kind === 'spawn') doc.spawns.splice(sel.i, 1);
      else if (sel.kind === 'pillar') removePillar(sel.i);
      else if (sel.kind === 'block') removeBlock(sel.i);
      sel = null; drawProps();
    }
    else if ((e.key === 'x' || e.key === 's') && !e.ctrlKey && !e.metaKey && sel && sel.kind === 'block') {
      // Toggle the SKYBOX marker flag (S is safe here: Ctrl+S saves, and the
      // guard above keeps it out of text fields).
      snap();
      const o = doc.blocks[sel.i];
      o.skybox = !o.skybox;
      drawProps(); status(o.skybox ? 'skybox marker (editor-only, no collision)' : 'solid block');
    }
    else if ('1234567'.includes(e.key)) setTool(['select', 'pillar', 'block', 'mook', 'elite', 'gunner', 'erase'][Number(e.key) - 1]);
  });

  function removePillar(i) {
    // Pinned spawns fall to the floor at the pillar's centre; higher indices shift.
    for (const sp of doc.spawns) {
      if (sp.pillar === i) { sp.x = doc.pillars[i].x + doc.pillars[i].w / 2; sp.pillar = null; }
      else if (sp.pillar > i) sp.pillar--;
    }
    doc.pillars.splice(i, 1);
  }
  function removeBlock(i) {
    for (const sp of doc.spawns) {
      if (sp.block === i) { sp.x = doc.blocks[i].x + doc.blocks[i].w / 2; sp.block = null; }
      else if (sp.block > i) sp.block--;
    }
    doc.blocks.splice(i, 1);
  }

  // ---- tools / toolbar ----
  function setTool(t) {
    tool = t;
    document.querySelectorAll('#bar button[data-tool]').forEach((b) =>
      b.classList.toggle('on', b.dataset.tool === t));
  }
  document.querySelectorAll('#bar button[data-tool]').forEach((b) =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  // ---- properties panel ----
  function drawProps() {
    if (!sel) {
      const mo = doc.spawns.filter((s) => spawnType(s) === 'mook').reduce((a, s) => a + s.count, 0);
      const el = doc.spawns.filter((s) => spawnType(s) === 'elite').reduce((a, s) => a + s.count, 0);
      const gu = doc.spawns.filter((s) => spawnType(s) === 'gunner').reduce((a, s) => a + s.count, 0);
      propsEl.innerHTML = '<span style="color:#5b6a94">no selection</span><br><br>'
        + doc.pillars.length + ' pillars · ' + doc.blocks.length + ' blocks<br>'
        + mo + ' mooks · ' + el + ' elites · ' + gu + ' gunners<br>'
        + 'p1 @ ' + doc.p1x + ' (drag the white stick)';
      return;
    }
    const num = (label, val, on, min, max, step) => {
      const id = 'p_' + label;
      setTimeout(() => { const el = document.getElementById(id);
        el.addEventListener('change', () => { snap(); on(Math.max(min, Math.min(max, Number(el.value)))); }); }, 0);
      return '<label>' + label + ' <input id="' + id + '" type="number" value="' + val
        + '" min="' + min + '" max="' + max + '" step="' + (step || 10) + '"></label>';
    };
    if (sel.kind === 'block') {
      const o = doc.blocks[sel.i];
      if (!o) { sel = null; return drawProps(); }
      propsEl.innerHTML = '<b>BLOCK ' + sel.i + (o.skybox ? ' · SKYBOX' : '') + '</b>'
        + num('x', o.x, (v) => { o.x = v; }, 0, doc.width - o.w)
        + num('width', o.w, (v) => { o.w = v; }, 40, 1200)
        + num('height', -(o.y || 0), (v) => { o.y = -v; }, 0, 560)
        + num('thick', Math.round(Number(o.h) || 30), (v) => { o.h = v; }, 30, 560)
        + '<label><input type="checkbox" id="p_sky"' + (o.skybox ? ' checked' : '')
        + '> skybox (marker only — no collision)</label>'
        + '<div style="margin-top:8px;color:#5b6a94">handles: right = width · top = height · bottom = thickness<br>'
        + 'all four faces solid: land on top, bonk under, wall at sides.<br>'
        + 'X or S toggles skybox while selected.</div>';
      setTimeout(() => {
        const sk = document.getElementById('p_sky');
        if (sk) sk.addEventListener('change', () => { snap(); o.skybox = sk.checked; drawProps(); });
      }, 0);
    } else if (sel.kind === 'pillar') {
      const p = doc.pillars[sel.i];
      if (!p) { sel = null; return drawProps(); }
      propsEl.innerHTML = '<b>PILLAR ' + sel.i + '</b>'
        + num('x', p.x, (v) => { p.x = v; }, 0, doc.width - p.w)
        + num('width', p.w, (v) => { p.w = v; }, 40, 600)
        + num('height', -(p.y || 0), (v) => { p.y = -v; }, 30, 500)
        + '<div style="margin-top:8px;color:#5b6a94">drag edges while selected:<br>right = width · top = height</div>';
    } else if (sel.kind === 'spawn') {
      const sp = doc.spawns[sel.i];
      if (!sp) { sel = null; return drawProps(); }
      const t = spawnType(sp);
      const pinned = pinObj(sp);
      propsEl.innerHTML = '<b>SPAWN ' + sel.i + '</b>'
        + '<label>type <select id="p_type">'
        + ['mook', 'elite', 'gunner'].map((k) =>
            '<option value="' + k + '"' + (k === t ? ' selected' : '') + '>' + k.toUpperCase() + '</option>').join('')
        + '</select></label>'
        + num('count', sp.count, (v) => { sp.count = Math.max(1, Math.min(8, v)); }, 1, 8, 1)
        + num('trigger x', sp.trigger == null ? '' : sp.trigger,
              (v) => { sp.trigger = v ? Math.max(100, Math.min(doc.width - 100, v)) : null; }, 100, doc.width - 100)
        + (pinned != null
            ? '<div style="margin-top:8px;color:#ffe066">pinned on '
              + (sp.block != null ? 'block ' + sp.block : 'pillar ' + sp.pillar) + '</div>'
              + '<label><input type="checkbox" id="p_pin" checked> pinned</label>'
            : '<div style="margin-top:8px;color:#5b6a94">floor zone — drop on a block/pillar to pin</div>')
        + '<div style="margin-top:6px;color:#5b6a94">trigger = mooks arrive when p1 passes x</div>';
      setTimeout(() => {
        const ty = document.getElementById('p_type');
        if (ty) ty.addEventListener('change', () => {
          snap();
          sp.knobs = TYPE_KNOBS[ty.value]();
          if (ty.value === 'gunner' && sp.block == null && sp.pillar == null) {
            // Auto-pin to the TALLEST solid (block or pillar) so the sniper
            // gets the high perch (rooftop gunners are the whole point).
            let best = 0, bestRef = null;
            doc.pillars.forEach((p, i) => { const hh = -(p.y || 0); if (hh > best) { best = hh; bestRef = { pillar: i }; } });
            doc.blocks.forEach((b, i) => { if (b.skybox) return; const hh = -(b.y || 0); if (hh > best) { best = hh; bestRef = { block: i }; } });
            if (bestRef) { Object.assign(sp, bestRef); sp.x = 0; status('gunner auto-pinned to tallest solid'); }
          }
          drawProps();
        });
        const pin = document.getElementById('p_pin');
        if (pin) pin.addEventListener('change', () => {
          snap();
          if (pin.checked) { const on = solidAtWorld(effX(sp));
            if (on) { if (on.kind === 'block') sp.block = on.i; else sp.pillar = on.i; sp.x = 0; } }
          else { sp.x = effX(sp); sp.block = null; sp.pillar = null; }
          drawProps();
        });
      }, 0);
    }
  }

  // ---- top-bar fields ----
  function syncFields() {
    descEl.value = doc.desc || '';
    widthEl.value = doc.width;
    const s = SKIES.find((k) => k.sky[0] === doc.sky[0] && k.sky[1] === doc.sky[1]);
    skyEl.value = s ? s.id : SKIES[0].id;
    doc.floors = [{ x: 0, w: doc.width }];
  }
  descEl.addEventListener('input', () => { doc.desc = descEl.value; });
  widthEl.addEventListener('change', () => {
    snap();
    doc.width = Math.max(1280, Math.min(8192, Number(widthEl.value) || 2600));
    widthEl.value = doc.width;
    doc.floors = [{ x: 0, w: doc.width }];
  });
  skyEl.addEventListener('change', () => {
    snap();
    doc.sky = SKIES.find((k) => k.id === skyEl.value).sky.slice();
  });

  // ---- waves: gang free zones behind each other ----
  document.getElementById('wavesBtn').addEventListener('click', () => {
    snap();
    const zs = doc.spawns.slice().sort((a, b) => effX(a) - effX(b));
    zs.forEach((sp, i) => {
      if (i === 0) { sp.trigger = null; return; }
      const ex = effX(sp);
      sp.trigger = Math.max(200, Math.min(doc.width - 100, snapG(ex - 320)));
    });
    status('waves: ' + zs.length + ' zones ganged');
  });

  // ---- save / load ----
  const cleanName = (n) => (n || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  function doSave() {
    const name = cleanName(nameEl.value);
    if (!name) return status('name: a-z 0-9 _ - required', true);
    if (window.LEVELS && window.LEVELS[name]) return status('"' + name + '" is a built-in name', true);
    if (doc.pillars.length === 0 && doc.blocks.length === 0 && doc.spawns.length === 0)
      return status('empty map — add something first', true);
    const all = loadLS();
    doc.floors = [{ x: 0, w: doc.width }];
    doc.respawnX = Math.max(60, doc.p1x - 40);
    all[name] = JSON.parse(JSON.stringify(doc));
    try { saveLS(all); } catch (e) { return status('localStorage full?', true); }
    nameEl.value = name;
    status('saved "' + name + '" ✓  ' + doc.pillars.length + ' pillars · ' + doc.blocks.length
           + ' blocks · ' + doc.spawns.length + ' zones');
    tryShare(name);
  }
  document.getElementById('saveBtn').addEventListener('click', doSave);
  document.getElementById('playBtn').addEventListener('click', () => {
    const name = cleanName(nameEl.value);
    if (!name || (window.LEVELS && window.LEVELS[name])) return status('bad name', true);
    const all = loadLS();
    all[name] = JSON.parse(JSON.stringify(doc));
    saveLS(all);
    // Hand the map through the URL too, not just localStorage: the playtest
    // must boot THIS map even when index.html runs on a different origin
    // (tunnel vs LAN vs Pages all have separate localStorage) or has a stale
    // cache. base64(JSON) survives URLs; index.html decodes ?map=.
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(doc))));
    location.href = 'index.html?level=' + encodeURIComponent(name) + '&map=' + encodeURIComponent(b64);
  });
  document.getElementById('backBtn').addEventListener('click', () => { location.href = 'index.html'; });
  document.getElementById('newBtn').addEventListener('click', () => {
    snap(); doc = blank(); sel = null; syncFields(); drawProps(); status('new map');
  });

  // Template dropdown: built-ins from levels.js (deep-cloned as start).
  const tplSel = document.getElementById('template');
  const tplOpt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; tplSel.appendChild(o); };
  tplOpt('', '— template —');
  if (window.LEVELS) Object.keys(window.LEVELS).forEach((k) => tplOpt('lvl:' + k, k));
  const customs = loadLS();
  Object.keys(customs).forEach((k) => tplOpt('cust:' + k, '♻ ' + k));
  tplSel.addEventListener('change', () => {
    const v = tplSel.value;
    if (!v) return;
    snap();
    const src = v.startsWith('lvl:') ? window.LEVELS[v.slice(4)] : customs[v.slice(5)];
    doc = normalize(JSON.parse(JSON.stringify(src || blank())));
    syncFields(); sel = null; drawProps();
    camX = doc.width / 2;
    status('loaded ' + v);
  });

  // ---- import/export modal ----
  const modal = document.getElementById('modal');
  const ioText = document.getElementById('ioText');
  document.getElementById('ioBtn').addEventListener('click', () => {
    ioText.value = JSON.stringify(doc, null, 1);
    modal.style.display = 'flex';
  });
  document.getElementById('closeBtn').addEventListener('click', () => { modal.style.display = 'none'; });
  document.getElementById('copyBtn').addEventListener('click', () => {
    ioText.select(); document.execCommand('copy'); status('copied JSON');
  });
  document.getElementById('importBtn').addEventListener('click', () => {
    try {
      const d = JSON.parse(ioText.value);
      if (typeof d.width !== 'number' || !Array.isArray(d.spawns)
          || (!Array.isArray(d.pillars) && !Array.isArray(d.blocks)))
        throw new Error('need width/pillars|blocks/spawns');
      snap();
      doc = {
        desc: String(d.desc || 'imported'), width: Math.max(1280, Math.min(8192, d.width)),
        sky: Array.isArray(d.sky) && d.sky.length === 2 ? d.sky.map(Number) : SKIES[0].sky.slice(),
        p1x: Number(d.p1x) || 200, respawnX: Number(d.respawnX) || 160,
        floors: [{ x: 0, w: Math.max(1280, Math.min(8192, d.width)) }],
        pillars: (d.pillars || []).map((p) => ({ x: Number(p.x) || 0, w: Math.max(40, Number(p.w) || 40), y: Math.max(-500, Math.min(-30, Number(p.y) || -30)) })),
        blocks: (d.blocks || []).map((b) => ({ x: Number(b.x) || 0, w: Math.max(40, Number(b.w) || 40),
          y: Math.max(-560, Math.min(0, Number(b.y) || -30)),
          h: Math.max(30, Math.min(560, Number(b.h) || 30)), skybox: !!b.skybox })),
        spawns: d.spawns.map((s) => {
          const o = { x: Number(s.x) || 0, count: Math.max(1, Math.min(8, Number(s.count) || 1)),
            trigger: s.trigger == null ? null : Number(s.trigger), knobs: s.knobs || {},
            pillar: s.pillar == null ? null : Math.max(0, Math.min((d.pillars || []).length - 1, Number(s.pillar))),
            block: s.block == null ? null : Math.max(0, Math.min((d.blocks || []).length - 1, Number(s.block))) };
          if (o.block != null) o.pillar = null;   // block pin wins; never both
          return o;
        }),
      };
      syncFields(); sel = null; drawProps(); modal.style.display = 'none';
      status('imported ✓');
    } catch (e) { status('bad JSON: ' + e.message, true); }
  });

  // ---- optional shared export: POST js/custom.js through nocache_server ----
  async function tryShare(name) {
    if (location.protocol !== 'http:') return;           // file:// — skip silently
    try {
      const all = loadLS();
      const body = 'window.CUSTOM_LEVELS = ' + JSON.stringify(all, null, 1) + ';\n';
      await fetch('js/custom.js', { method: 'PUT', body });
    } catch (e) { /* server without PUT (GitHub Pages) — localStorage is enough */ }
  }

  // ---- main draw ----
  function stickman(px, py, col, s) {
    // px,py = feet; s = scale px (height ~50*s)
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = Math.max(1, 2.5 * s);
    const hipY = py - 26 * s, headY = py - 46 * s;
    ctx.beginPath(); ctx.moveTo(px, py - 40 * s); ctx.lineTo(px, hipY); ctx.stroke();  // torso
    ctx.beginPath(); ctx.arc(px, headY, 6 * s, 0, 7); ctx.fill();                      // head
    ctx.beginPath(); ctx.moveTo(px, py - 36 * s); ctx.lineTo(px - 9 * s, py - 26 * s);
    ctx.moveTo(px, py - 36 * s); ctx.lineTo(px + 9 * s, py - 26 * s); ctx.stroke();    // arms
    ctx.beginPath(); ctx.moveTo(px, hipY); ctx.lineTo(px - 7 * s, py);
    ctx.moveTo(px, hipY); ctx.lineTo(px + 7 * s, py); ctx.stroke();                    // legs
  }
  function draw() {
    const W = doc.width;
    // sky
    const g = ctx.createLinearGradient(0, 0, 0, CH);
    g.addColorStop(0, '#' + ('000000' + (doc.sky[0] >>> 0).toString(16)).slice(-6));
    g.addColorStop(1, '#' + ('000000' + (doc.sky[1] >>> 0).toString(16)).slice(-6));
    ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
    // floor slab + world edges
    ctx.fillStyle = '#2a3050'; ctx.fillRect(sx(0), sy(GROUND), W * zoom, CH - sy(GROUND) + 40);
    ctx.strokeStyle = '#4a557e'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx(0), sy(GROUND)); ctx.lineTo(sx(W), sy(GROUND)); ctx.stroke();
    ctx.strokeStyle = '#ff5a5a'; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(sx(0), 0); ctx.lineTo(sx(0), CH); ctx.moveTo(sx(W), 0); ctx.lineTo(sx(W), CH); ctx.stroke();
    ctx.setLineDash([]);
    // grid
    if (zoom > 0.5) {
      ctx.strokeStyle = 'rgba(111,134,200,0.08)'; ctx.lineWidth = 1;
      for (let gx = Math.floor(wx(0) / 100) * 100; gx < wx(CW); gx += 100) {
        ctx.beginPath(); ctx.moveTo(sx(gx), 0); ctx.lineTo(sx(gx), sy(GROUND)); ctx.stroke();
      }
    }
    // legacy pillars (solid columns to the floor)
    doc.pillars.forEach((p, i) => {
      const on = sel && sel.kind === 'pillar' && sel.i === i;
      ctx.fillStyle = on ? '#2f3c66' : '#232c4c';
      ctx.fillRect(sx(p.x), sy(objTop(p)), p.w * zoom, (GROUND - objTop(p)) * zoom);
      ctx.strokeStyle = on ? '#ffe066' : '#6f86c8';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx(p.x), sy(objTop(p)), p.w * zoom, (GROUND - objTop(p)) * zoom);
      if (on) {
        ctx.fillStyle = '#ffe066';
        ctx.fillRect(sx(p.x + p.w) - 4, sy((objTop(p) + GROUND) / 2) - 4, 8, 8);
        ctx.fillRect(sx(p.x + p.w / 2) - 4, sy(objTop(p)) - 4, 8, 8);
      }
    });
    // BLOCKS: true rects anywhere. Solid = filled with land-line on top;
    // SKYBOX = dashed ghost marker (no collision in game — planned opening).
    doc.blocks.forEach((b, i) => {
      const on = sel && sel.kind === 'block' && sel.i === i;
      const top = objTop(b), bot = objBottom(b);
      if (b.skybox) {
        ctx.fillStyle = 'rgba(120,220,255,0.07)';
        ctx.fillRect(sx(b.x), sy(top), b.w * zoom, (bot - top) * zoom);
        ctx.strokeStyle = on ? '#ffe066' : '#7fd6ff';
        ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
        ctx.strokeRect(sx(b.x), sy(top), b.w * zoom, (bot - top) * zoom);
        ctx.setLineDash([]);
        ctx.fillStyle = '#7fd6ff'; ctx.font = '10px monospace';
        ctx.fillText('SKYBOX', sx(b.x) + 4, sy(top) + 12);
      } else {
        ctx.fillStyle = on ? '#2f3c66' : '#232c4c';
        ctx.fillRect(sx(b.x), sy(top), b.w * zoom, (bot - top) * zoom);
        ctx.strokeStyle = on ? '#ffe066' : '#6f86c8';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx(b.x), sy(top), b.w * zoom, (bot - top) * zoom);
        // landable top = bright line
        ctx.strokeStyle = '#9db8f0'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx(b.x), sy(top)); ctx.lineTo(sx(b.x + b.w), sy(top)); ctx.stroke();
      }
      if (on) {
        ctx.fillStyle = '#ffe066';
        ctx.fillRect(sx(b.x + b.w) - 4, sy((top + bot) / 2) - 4, 8, 8);
        ctx.fillRect(sx(b.x + b.w / 2) - 4, sy(top) - 4, 8, 8);
        ctx.fillRect(sx(b.x + b.w / 2) - 4, sy(bot) - 4, 8, 8);
      }
    });
    // spawn zones
    doc.spawns.forEach((sp, i) => {
      const t = spawnType(sp);
      const px = sx(effX(sp)), py = sy(spawnY(sp));
      // True 1:1 scale: s = 92/52 makes the stickman exactly the game's 92px
      // body at zoom 1 (the user reads these as the ruler — must not lie).
      // SPACING 56 = fireZone's per-mook cluster step.
      const SPACING = 56;
      for (let c = 0; c < sp.count; c++) {
        stickman(px + (c - (sp.count - 1) / 2) * SPACING * zoom, py, TYPE_COLOR[t], zoom * (92 / 52));
      }
      if (sel && sel.kind === 'spawn' && sel.i === i) {
        ctx.strokeStyle = '#ffe066'; ctx.setLineDash([4, 4]);
        ctx.strokeRect(px - ((sp.count - 1) * SPACING / 2 + 20) * zoom, py - 98 * zoom,
                       ((sp.count - 1) * SPACING + 40) * zoom, 102 * zoom);
        ctx.setLineDash([]);
      }
      ctx.fillStyle = '#cdd6f4'; ctx.font = Math.max(9, 11 * zoom) + 'px monospace';
      ctx.fillText(sp.count + '×' + (t === 'gunner' ? '🔫' : t[0].toUpperCase()),
        px - 18 * zoom, py - 104 * zoom);
      if (sp.trigger != null) {
        ctx.fillStyle = '#ff8f5a';
        ctx.fillText('⚑' + sp.trigger, sx(sp.trigger) - 8, sy(GROUND) + 16);
        ctx.strokeStyle = 'rgba(255,143,90,0.5)'; ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(sx(sp.trigger), sy(GROUND) - 8); ctx.lineTo(sx(sp.trigger), sy(GROUND) + 8); ctx.stroke();
        ctx.setLineDash([]);
        // Selected spawn: show its FULL trigger line — the x where p1 must
        // walk to arm this gang (user asked for it: the tick alone was too
        // easy to miss, and its distance-to-spawn is the thing you tune).
        if (sel && sel.kind === 'spawn' && sel.i === i) {
          ctx.strokeStyle = 'rgba(255,143,90,0.9)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(sx(sp.trigger), 0); ctx.lineTo(sx(sp.trigger), sy(GROUND)); ctx.stroke();
          // connect trigger -> spawn cluster so the "walk here, they come" read is instant
          ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(sx(sp.trigger), sy(GROUND) - 46 * zoom);
          ctx.lineTo(px, sy(GROUND) - 46 * zoom); ctx.stroke();
          ctx.setLineDash([]); ctx.lineWidth = 2;
          ctx.fillStyle = '#ff8f5a'; ctx.font = '11px monospace';
          ctx.fillText('trigger @ ' + sp.trigger + '  (walk here)', sx(sp.trigger) + 6, 24);
          const dist = Math.round(effX(sp) - sp.trigger);
          ctx.fillText('+' + dist + 'px ahead', sx(sp.trigger) + 6, 40);
        }
      } else if (sel && sel.kind === 'spawn' && sel.i === i) {
        ctx.fillStyle = '#5b6a94'; ctx.font = '11px monospace';
        ctx.fillText('no trigger (waves with previous)', px - 60 * zoom, 24);
      }
    });
    // p1 — same true scale as the spawn figures (it IS the player body).
    stickman(sx(doc.p1x), sy(GROUND), '#f2f2f2', zoom * (92 / 52));
    if (sel && sel.kind === 'p1') {
      ctx.strokeStyle = '#ffe066'; ctx.setLineDash([4, 4]);
      ctx.strokeRect(sx(doc.p1x) - 20 * zoom, sy(GROUND) - 92 * zoom, 40 * zoom, 92 * zoom);
      ctx.setLineDash([]);
    }
    // ghost while dragging (pillar = floor column; block = free rect)
    if (ghost && ghost.x1 != null) {
      const a = Math.min(ghost.x0, ghost.x1), b = Math.max(ghost.x0, ghost.x1);
      if (ghost.kind === 'block' && ghost.y1 != null) {
        const t = Math.min(ghost.y0, ghost.y1), bo = Math.max(ghost.y0, ghost.y1);
        ctx.fillStyle = 'rgba(111,134,200,0.3)';
        ctx.fillRect(sx(a), sy(t), (b - a) * zoom, (bo - t) * zoom);
        ctx.fillStyle = '#cdd6f4'; ctx.font = '11px monospace';
        ctx.fillText(Math.round(b - a) + 'w × ' + Math.round(bo - t) + 'h', sx(a) + 4, sy(t) - 6);
      } else {
        ctx.fillStyle = 'rgba(111,134,200,0.3)';
        ctx.fillRect(sx(a), sy(GROUND - 80), (b - a) * zoom, 80 * zoom);
        ctx.fillStyle = '#cdd6f4'; ctx.font = '11px monospace';
        ctx.fillText(Math.round(b - a) + 'w', sx(a) + 4, sy(GROUND - 86));
      }
    }
    // scale readout
    ctx.fillStyle = '#5b6a94'; ctx.font = '11px monospace';
    ctx.fillText('zoom ' + zoom.toFixed(2) + '  x:' + Math.round(wx(CW / 2)) + '/' + W, 10, CH - 10);
    requestAnimationFrame(draw);
  }

  // ---- boot ----
  skyEl.innerHTML = SKIES.map((k) => '<option value="' + k.id + '">' + k.name + '</option>').join('');
  const params = new URLSearchParams(location.search);
  const edit = params.get('edit');
  if (edit) {
    const fromLS = loadLS()[edit];
    const src = fromLS || (window.LEVELS && window.LEVELS[edit]);
    if (src) { doc = normalize(JSON.parse(JSON.stringify(src))); nameEl.value = edit; status('editing "' + edit + '"'); }
    else status('"' + edit + '" not found', true);
  } else if (params.get('new') !== null) {
    doc = blank();
  }
  syncFields(); drawProps();
  camX = doc.width / 2;
  requestAnimationFrame(draw);
  window.__EDITOR = { get doc() { return doc; }, set doc(v) { doc = v; syncFields(); } };
})();
