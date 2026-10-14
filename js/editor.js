// editor.js — standalone map editor for Stick Fight (editor.html).
// Edits the EXACT window.LEVELS shape (see js/levels.js header) and saves to
// localStorage under 'stickfight.customLevels' ({name: levelData}), which
// index.html (menu cards) and main.js (loadLevel) both read. No game code is
// loaded here — only levels.js for templates — so the editor boots instantly
// and can never crash on game changes.
//
// World coords match the game: groundY 620, pillar {x,w,y} with y = height
// above ground (negative). Screen mapping pins the ground line at cy 540:
//   sy = wy*zoom + (540 - 620*zoom)
// so zoom never moves the floor.
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
      pillars: [], spawns: [],
    };
  }

  let doc = blank();
  let tool = 'select';
  let sel = null;              // {kind:'pillar'|'spawn'|'p1', i}
  let camX = 1300, zoom = 1;   // view centre (world px) / zoom
  let drag = null;             // active drag state
  let ghost = null;            // pillar-create preview {x0,x1}
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
  const effX = (sp) => sp.pillar != null && doc.pillars[sp.pillar]
    ? doc.pillars[sp.pillar].x + doc.pillars[sp.pillar].w / 2 : sp.x;
  const pillarTop = (p) => GROUND + (p.y || 0);
  const spawnY = (sp) => sp.pillar != null && doc.pillars[sp.pillar]
    ? pillarTop(doc.pillars[sp.pillar]) : GROUND;
  const spawnType = (sp) => (sp.knobs && sp.knobs.weapon) ? 'gunner'
    : (sp.knobs && sp.knobs.hp > 12) ? 'elite' : 'mook';
  const TYPE_KNOBS = {
    mook: () => ({}),
    elite: () => ({ hp: 24, aggression: 1.6 }),
    gunner: () => ({ weapon: 'pistol' }),
  };
  const TYPE_COUNT = { mook: 4, elite: 2, gunner: 1 };
  const TYPE_COLOR = { mook: '#ff8f5a', elite: '#ffd166', gunner: '#ffe066' };

  // Hit tests in screen space (topmost first: handles > spawns > p1 > pillar).
  function pick(mx, my) {
    // resize handles on a selected pillar
    if (sel && sel.kind === 'pillar') {
      const p = doc.pillars[sel.i];
      if (p) {
        const hx = sx(p.x + p.w), hy = sy(pillarTop(p) + (GROUND - pillarTop(p)) / 2);
        if (Math.hypot(mx - hx, my - hy) < 9) return { kind: 'handle-w', i: sel.i };
        const tx = sx(p.x + p.w / 2), ty = sy(pillarTop(p));
        if (Math.hypot(mx - tx, my - ty) < 9) return { kind: 'handle-h', i: sel.i };
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
    for (let i = doc.pillars.length - 1; i >= 0; i--) {
      const p = doc.pillars[i];
      if (mx >= sx(p.x) && mx <= sx(p.x + p.w) && my >= sy(pillarTop(p)) && my <= sy(GROUND))
        return { kind: 'pillar', i };
    }
    return null;
  }

  const pillarAtWorld = (wpx) => {
    for (let i = doc.pillars.length - 1; i >= 0; i--) {
      const p = doc.pillars[i];
      if (wpx >= p.x && wpx <= p.x + p.w) return i;
    }
    return null;
  };

  // ---- pointer state ----
  let panning = null;      // {mx0, camX0}
  let moving = null;       // {kind, i, grab} offsets

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
    if (tool === 'pillar') { ghost = { x0: snapG(wx(mx)) }; return; }
    if (tool === 'erase') {
      const k = pick(mx, my);
      if (!k || k.kind === 'handle-w' || k.kind === 'handle-h') return;
      snap();
      if (k.kind === 'spawn') doc.spawns.splice(k.i, 1);
      else if (k.kind === 'pillar') removePillar(k.i);
      sel = null; drawProps(); return;
    }
    if (tool === 'mook' || tool === 'elite' || tool === 'gunner') {
      snap();
      const wpx = snapG(wx(mx));
      const onPil = pillarAtWorld(wpx);
      const sp = { x: wpx, count: TYPE_COUNT[tool], knobs: TYPE_KNOBS[tool]() };
      if (onPil != null) { sp.pillar = onPil; sp.x = 0; }   // x unused when pinned
      doc.spawns.push(sp);
      sel = { kind: 'spawn', i: doc.spawns.length - 1 };
      drawProps(); return;
    }
    // select tool on an object: pick + start move
    const k = pick(mx, my);
    if (!k) return;
    sel = k.kind.startsWith('handle') ? { kind: 'pillar', i: k.i } : k;
    drawProps();
    if (k.kind === 'handle-w' || k.kind === 'handle-h') {
      snap(); moving = { kind: k.kind, i: k.i };
    } else if (k.kind === 'pillar' || k.kind === 'spawn') {
      snap();
      moving = { kind: k.kind, i: k.i, grab: wx(mx) - effX(k.kind === 'pillar' ? doc.pillars[k.i] : Object.assign({ x: effX(doc.spawns[k.i]) }, {})) };
      if (k.kind === 'spawn' && doc.spawns[k.i].pillar != null) doc.spawns[k.i].pillar = null; // unpinned drag follows x
    } else if (k.kind === 'p1') { snap(); moving = { kind: 'p1', grab: wx(mx) - doc.p1x }; }
  });
  addEventListener('mousemove', (e) => {
    const r = cv.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (CW / r.width);
    const my = (e.clientY - r.top) * (CH / r.height);
    if (panning) { camX = panning.camX0 - ((e.clientX - r.left) - panning.mx0) * (CW / r.width) / zoom; return; }
    if (ghost) { ghost.x1 = snapG(wx(mx)); return; }
    if (!moving) return;
    const W = Number(widthEl.value) || doc.width;
    if (moving.kind === 'p1') {
      doc.p1x = Math.max(40, Math.min(W - 40, snapG(wx(mx) - moving.grab)));
    } else if (moving.kind === 'handle-w') {
      const p = doc.pillars[moving.i];
      p.w = Math.max(40, Math.min(600, snapG(wx(mx) - p.x)));
    } else if (moving.kind === 'handle-h') {
      const p = doc.pillars[moving.i];
      p.y = Math.max(-500, Math.min(-30, snapG(wy(my) - GROUND)));
    } else if (moving.kind === 'pillar') {
      const p = doc.pillars[moving.i];
      p.x = Math.max(0, Math.min(W - p.w, snapG(wx(mx) - moving.grab)));
    } else if (moving.kind === 'spawn') {
      doc.spawns[moving.i].x = Math.max(20, Math.min(W - 20, snapG(wx(mx) - moving.grab)));
    }
  });
  addEventListener('mouseup', () => {
    if (ghost && ghost.x1 != null) {
      const a = Math.min(ghost.x0, ghost.x1), b = Math.max(ghost.x0, ghost.x1);
      if (b - a >= 40) {
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
      sel = null; drawProps();
    }
    else if ('123456'.includes(e.key)) setTool(['select', 'pillar', 'mook', 'elite', 'gunner', 'erase'][Number(e.key) - 1]);
  });

  function removePillar(i) {
    // Pinned spawns fall to the floor at the pillar's centre; higher indices shift.
    for (const sp of doc.spawns) {
      if (sp.pillar === i) { sp.x = doc.pillars[i].x + doc.pillars[i].w / 2; sp.pillar = null; }
      else if (sp.pillar > i) sp.pillar--;
    }
    doc.pillars.splice(i, 1);
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
        + doc.pillars.length + ' pillars<br>' + mo + ' mooks · ' + el + ' elites · ' + gu + ' gunners<br>'
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
    if (sel.kind === 'pillar') {
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
      propsEl.innerHTML = '<b>SPAWN ' + sel.i + '</b>'
        + '<label>type <select id="p_type">'
        + ['mook', 'elite', 'gunner'].map((k) =>
            '<option value="' + k + '"' + (k === t ? ' selected' : '') + '>' + k.toUpperCase() + '</option>').join('')
        + '</select></label>'
        + num('count', sp.count, (v) => { sp.count = Math.max(1, Math.min(8, v)); }, 1, 8, 1)
        + num('trigger x', sp.trigger == null ? '' : sp.trigger,
              (v) => { sp.trigger = v ? Math.max(100, Math.min(doc.width - 100, v)) : null; }, 100, doc.width - 100)
        + (sp.pillar != null
            ? '<div style="margin-top:8px;color:#ffe066">pinned on pillar ' + sp.pillar + '</div>'
              + '<label><input type="checkbox" id="p_pin" checked> pinned</label>'
            : '<div style="margin-top:8px;color:#5b6a94">floor zone — drop on a pillar to pin</div>')
        + '<div style="margin-top:6px;color:#5b6a94">trigger = mooks arrive when p1 passes x</div>';
      setTimeout(() => {
        const ty = document.getElementById('p_type');
        if (ty) ty.addEventListener('change', () => {
          snap();
          sp.knobs = TYPE_KNOBS[ty.value]();
          if (ty.value === 'gunner' && sp.pillar == null) {
            // Auto-pin to the tallest pillar so the sniper gets his perch.
            let best = -1, bi = null;
            doc.pillars.forEach((p, i) => { if ((p.y || 0) < best) { best = p.y || 0; bi = i; } });
            if (bi != null) { sp.pillar = bi; sp.x = 0; status('gunner auto-pinned to tallest pillar'); }
          }
          drawProps();
        });
        const pin = document.getElementById('p_pin');
        if (pin) pin.addEventListener('change', () => {
          snap();
          if (pin.checked) { const i = pillarAtWorld(effX(sp)); if (i != null) { sp.pillar = i; sp.x = 0; } }
          else { sp.x = effX(sp); sp.pillar = null; }
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
    if (doc.pillars.length === 0 && doc.spawns.length === 0)
      return status('empty map — add something first', true);
    const all = loadLS();
    doc.floors = [{ x: 0, w: doc.width }];
    doc.respawnX = Math.max(60, doc.p1x - 40);
    all[name] = JSON.parse(JSON.stringify(doc));
    try { saveLS(all); } catch (e) { return status('localStorage full?', true); }
    nameEl.value = name;
    status('saved "' + name + '" ✓  ' + doc.pillars.length + ' pillars · ' + doc.spawns.length + ' zones');
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
    doc = JSON.parse(JSON.stringify(src || blank()));
    doc.width = doc.width || 2600;
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
      if (typeof d.width !== 'number' || !Array.isArray(d.pillars) || !Array.isArray(d.spawns))
        throw new Error('need width/pillars/spawns');
      snap();
      doc = {
        desc: String(d.desc || 'imported'), width: Math.max(1280, Math.min(8192, d.width)),
        sky: Array.isArray(d.sky) && d.sky.length === 2 ? d.sky.map(Number) : SKIES[0].sky.slice(),
        p1x: Number(d.p1x) || 200, respawnX: Number(d.respawnX) || 160,
        floors: [{ x: 0, w: Math.max(1280, Math.min(8192, d.width)) }],
        pillars: d.pillars.map((p) => ({ x: Number(p.x) || 0, w: Math.max(40, Number(p.w) || 40), y: Math.max(-500, Math.min(-30, Number(p.y) || -30)) })),
        spawns: d.spawns.map((s) => ({ x: Number(s.x) || 0, count: Math.max(1, Math.min(8, Number(s.count) || 1)),
          trigger: s.trigger == null ? null : Number(s.trigger), knobs: s.knobs || {},
          pillar: s.pillar == null ? null : Math.max(0, Math.min(d.pillars.length - 1, Number(s.pillar))) })),
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
    // pillars
    doc.pillars.forEach((p, i) => {
      ctx.fillStyle = i === (sel && sel.kind === 'pillar' ? sel.i : -1) ? '#2f3c66' : '#232c4c';
      ctx.fillRect(sx(p.x), sy(pillarTop(p)), p.w * zoom, (GROUND - pillarTop(p)) * zoom);
      ctx.strokeStyle = i === (sel && sel.kind === 'pillar' ? sel.i : -1) ? '#ffe066' : '#6f86c8';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx(p.x), sy(pillarTop(p)), p.w * zoom, (GROUND - pillarTop(p)) * zoom);
      // resize handles
      if (sel && sel.kind === 'pillar' && sel.i === i) {
        ctx.fillStyle = '#ffe066';
        ctx.fillRect(sx(p.x + p.w) - 4, sy(pillarTop(p) + (GROUND - pillarTop(p)) / 2) - 4, 8, 8);
        ctx.fillRect(sx(p.x + p.w / 2) - 4, sy(pillarTop(p)) - 4, 8, 8);
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
      }
    });
    // p1 — same true scale as the spawn figures (it IS the player body).
    stickman(sx(doc.p1x), sy(GROUND), '#f2f2f2', zoom * (92 / 52));
    if (sel && sel.kind === 'p1') {
      ctx.strokeStyle = '#ffe066'; ctx.setLineDash([4, 4]);
      ctx.strokeRect(sx(doc.p1x) - 20 * zoom, sy(GROUND) - 92 * zoom, 40 * zoom, 92 * zoom);
      ctx.setLineDash([]);
    }
    // ghost pillar while dragging
    if (ghost && ghost.x1 != null) {
      const a = Math.min(ghost.x0, ghost.x1), b = Math.max(ghost.x0, ghost.x1);
      ctx.fillStyle = 'rgba(111,134,200,0.3)';
      ctx.fillRect(sx(a), sy(GROUND - 80), (b - a) * zoom, 80 * zoom);
      ctx.fillStyle = '#cdd6f4'; ctx.font = '11px monospace';
      ctx.fillText(Math.round(b - a) + 'w', sx(a) + 4, sy(GROUND - 86));
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
    if (src) { doc = JSON.parse(JSON.stringify(src)); nameEl.value = edit; status('editing "' + edit + '"'); }
    else status('"' + edit + '" not found', true);
  } else if (params.get('new') !== null) {
    doc = blank();
  }
  syncFields(); drawProps();
  camX = doc.width / 2;
  requestAnimationFrame(draw);
  window.__EDITOR = { get doc() { return doc; }, set doc(v) { doc = v; syncFields(); } };
})();
