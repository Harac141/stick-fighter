// main.js — scene: stage, players, fixed-step sim loop, hitbox resolution.
//
// Controls (P1 single player): A/D move, Space jump, Shift dash,
//   J punch, K heavy; W/S are attack-direction modifiers:
//   W+J uppercut, W+K cartwheel, S+J sweep, S+K hammerfist;
//   in air: J air jab, K axe kick; during dash: J/K shoulder check.
// P2 (duel demo): Arrows move/jump, / dash, , (comma) jab, . (period) heavy.
// F1: toggle hitbox/hurtbox debug view.
//
// The simulation runs at a FIXED 60 Hz step (accumulator pattern) independent
// of the render rate, so frame data behaves identically on 60/144/165 Hz
// monitors — the single most important thing for "no lag" fighting feel.

const SIM_STEP = Fighter.STEP;

class FightScene extends Phaser.Scene {
  constructor() { super('fight'); }

  create() {
    const W = 1280, H = 720;
    this.groundY = 620;
    // Level width (scrolling): ?width= overrides for testing; default = one
    // screen so the duel behaves exactly as before (camera clamps to 0).
    const urlW = Number(new URLSearchParams(location.search).get('width'));
    this.levelWidth = Number.isFinite(urlW) ? Math.max(W, Math.min(8192, urlW)) : W;
    // Camera subject: 'duel' = midpoint of the two fighters (classic FG cam),
    // 'follow' = P1 only with facing lookahead (?follow=1; this becomes the
    // mook-carving camera).
    this.camMode = new URLSearchParams(location.search).get('follow') ? 'follow' : 'duel';
    // Floor plane at groundY (620) so feet rest on the DRAWN floor line, not the canvas bottom.
    this.physics.world.setBounds(0, 0, this.levelWidth, this.groundY);
    this.physics.world.gravity.y = CFG.gravity;

    // ---- Stage art (drawn once, spans the whole level) ----
    const bg = this.add.graphics();
    // Sky.
    bg.fillGradientStyle(0x101423, 0x101423, 0x1b2440, 0x1b2440, 1);
    bg.fillRect(0, 0, this.levelWidth, H);
    // Floor slab.
    bg.fillStyle(0x2a3050, 1);
    bg.fillRect(0, this.groundY, this.levelWidth, H - this.groundY);
    bg.lineStyle(3, 0x4a557e, 1);
    bg.lineBetween(0, this.groundY, this.levelWidth, this.groundY);
    // Back wall lanes for dojo depth.
    bg.lineStyle(1, 0x232b48, 1);
    for (let px = 100; px < this.levelWidth; px += 100) bg.lineBetween(px, 120, px, this.groundY);

    // ---- Fighters ----
    const mid = this.levelWidth / 2;
    this.p1 = new Fighter(this, mid - 220, this.groundY, 1, 0xf2f2f2);
    this.p2 = new Fighter(this, mid + 220, this.groundY, -1, 0x9ad0ff);
    this.p1.inputKey = 'p1'; this.p2.inputKey = 'p2';   // map to keyboard input slots
    // Master roster: everyone the sim steps, hits and separates. p1/p2 stay
    // as named refs (input + HUD); mooks append here (ai-driven).
    this.fighters = [this.p1, this.p2];

    // ---- Mook arena (?mooks=N spawns N AI fighters on the right half) ----
    const urlM = Number(new URLSearchParams(location.search).get('mooks'));
    this.mookCount = Number.isFinite(urlM) ? Math.max(0, Math.min(24, urlM)) : 0;
    if (this.mookCount > 0) {
      // Arena mode: solo vs mooks. P2 leaves the roster (not drawn/simulated/
      // hittable) — the duel shell stays available at mooks=0 for the boss.
      this.fighters = [this.p1];
      this.spawnMooks(this.mookCount);
    }

    // ---- Input ----
    const kb = this.input.keyboard;
    kb.addCapture(Phaser.Input.Keyboard.KeyCodes.WASD);   // S = down modifier (W = up modifier now)
    kb.addCapture(Phaser.Input.Keyboard.KeyCodes.SPACE);  // jump: stop page scroll
    kb.addCapture(Phaser.Input.Keyboard.KeyCodes.ARROWS);
    kb.addCapture([Phaser.Input.Keyboard.KeyCodes.SHIFT,
                   Phaser.Input.Keyboard.KeyCodes.COMMA,
                   Phaser.Input.Keyboard.KeyCodes.PERIOD,
                   Phaser.Input.Keyboard.KeyCodes.SLASH,
                   Phaser.Input.Keyboard.KeyCodes.J,
                   Phaser.Input.Keyboard.KeyCodes.K]);
    this.keys = {
      // P1 (single-player): jump = SPACE; W is the UP attack-direction modifier
      // (up+attack = launcher), not a jump. S is the DOWN modifier (sweep/hammer).
      p1: { left: kb.addKey('A'), right: kb.addKey('D'), jump: kb.addKey('SPACE'),
            up: kb.addKey('W'), down: kb.addKey('S'),
            dash: kb.addKey('SHIFT'), jab: kb.addKey('J'), heavy: kb.addKey('K') },
      // P2 (duel demo shell): arrows; UP doubles as its jump and up-modifier.
      p2: { left: kb.addKey('LEFT'), right: kb.addKey('RIGHT'), jump: kb.addKey('UP'),
            up: kb.addKey('UP'), down: kb.addKey('DOWN'),
            dash: kb.addKey('SLASH'), jab: kb.addKey('COMMA'), heavy: kb.addKey('PERIOD') },
    };
    kb.on('keydown-F1', () => { Fighter.debug = !Fighter.debug; });

    // One-frame edge buffers: inputs pressed between sim steps still register.
    this.buffer = { p1: {}, p2: {} };
    for (const who of ['p1', 'p2']) {
      for (const act of ['jab', 'heavy', 'dash']) this.buffer[who][act] = 0; this.buffer[who].dashSrc = null;
    }
    // Wire edge-detect for one-shot actions.
    const wire = (who, act, key) => {
      key.on('down', () => {
        this.buffer[who][act] = 3;          // 3-step buffer window
        if (act === 'dash') this.buffer[who].dashSrc = 'shift';
      });
    };
    wire('p1', 'jab', this.keys.p1.jab);   wire('p1', 'heavy', this.keys.p1.heavy);
    wire('p1', 'dash', this.keys.p1.dash);
    wire('p2', 'jab', this.keys.p2.jab);   wire('p2', 'heavy', this.keys.p2.heavy);
    wire('p2', 'dash', this.keys.p2.dash);

    // ---- Double-tap-to-dash on direction keys ----
    // Two fresh downs of the same direction key within the window fire a dash.
    // e.repeat guard: browsers auto-repeat keydown while a key is HELD, which
    // would otherwise trigger a dash every ~30ms of holding.
    const TAP_WINDOW_MS = 260;
    const wireDoubleTap = (who, key) => {
      let lastTap = -1e9;
      key.on('down', (keyObj, domEvent) => {
        // Guard auto-repeat: holding a key must NOT read as a double-tap.
        // (Phaser may already suppress repeat, but don't depend on it.)
        if (domEvent && domEvent.repeat) return;
        const now = performance.now();
        if (now - lastTap <= TAP_WINDOW_MS) {
          this.buffer[who].dash = 3;
          this.buffer[who].dashSrc = 'tap';
          lastTap = -1e9;                    // need a fresh pair for another
        } else {
          lastTap = now;
        }
      });
    };
    wireDoubleTap('p1', this.keys.p1.left);
    wireDoubleTap('p1', this.keys.p1.right);
    wireDoubleTap('p2', this.keys.p2.left);
    wireDoubleTap('p2', this.keys.p2.right);

    // ---- Camera (render-side smoothing; sim stays camera-independent) ----
    // Manual follow (not startFollow) keeps us version-proof and gives the
    // exact duel/follow semantics below. Shake is an OFFSET on the followed
    // position, not an absolute scroll (the old behaviour).
    this.shakeT = 0; this.shakeMag = 0;
    this.camX = null;                        // eased view centre; lazy-init on frame 1
    this.cameras.main.setBounds(0, 0, this.levelWidth, H);

    // ---- HUD (screen-fixed: must not scroll with the world) ----
    this.hud = this.add.graphics();
    this.hud.setScrollFactor(0);

    this.acc = 0;
    this.game.events.once('shutdown', () => {});
  }

  sampleInput(who) {
    const k = this.keys[who], b = this.buffer[who];
    const inp = {};
    // Held states.
    inp.left = k.left.isDown;
    inp.right = k.right.isDown;
    inp.jumpHeld = k.jump.isDown;
    inp.down = !!k.down && k.down.isDown;   // DOWN modifier (sweep/hammerfist)
    inp.up   = !!k.up   && k.up.isDown;      // UP modifier (uppercut/cartwheel)
    // One-shot states consumed from buffer.
    inp.jump = b.jump > 0 || (k.jump.isDown && !this['prevJump_' + who]);
    this['prevJump_' + who] = k.jump.isDown;
    inp.jab = b.jab > 0;
    inp.heavy = b.heavy > 0;
    inp.dash = b.dash > 0;
    inp.dashSrc = b.dashSrc;
    inp.dashHeld = k.dash.isDown;
    inp.heldDir = k.left.isDown ? -1 : (k.right.isDown ? 1 : 0);
    // Decay buffers each sim step.
    for (const a of ['jab', 'heavy', 'dash']) if (b[a] > 0) b[a]--;
    if (b.dash === 0) b.dashSrc = null;
    return inp;
  }

  update(time, deltaMs) {
    // Fixed-step accumulator (clamped to avoid spiral-of-death after tab-out).
    this.acc += Math.min(deltaMs, 100) / 1000;
    let steps = 0;
    while (this.acc >= SIM_STEP && steps < 5) {
      this.simStep();
      this.acc -= SIM_STEP;
      steps++;
    }
    this.renderAll();
  }

  // ---- Mooks ----
  // A mook IS a player fighter with a MookAI attached: same class, same
  // moveset, same physics. Difficulty = knobs. Spawns on the right half.
  spawnMooks(n) {
    // Engagement queue (Bruce Lee one-at-a-time). OFF by DEFAULT: the queue
    // currently wedges (holder stalls ~320px, nothing lands — see
    // todocombat). Free-for-all is the known-good pack until that's fixed.
    // Test the queue with ?queue=1.
    const wantQueue = new URLSearchParams(location.search).get('queue') === '1';
    this.eng = wantQueue ? new EngagementManager({ slots: 1 }) : null;
    for (let i = 0; i < n; i++) {
      const x = Math.min(this.levelWidth - 80,
        this.levelWidth * 0.62 + i * 60 + (Math.random() * 40 - 20));
      const m = new Fighter(this, x, this.groundY, -1, 0xff8f5a);
      new MookAI(m, { mgr: this.eng });
      this.fighters.push(m);
    }
  }

  simStep() {
    const i1 = this.sampleInput('p1');
    const i2 = this.sampleInput('p2');
    this.lastIn = { p1: i1, p2: i2 };   // press-intent for separateBodies
    for (const f of this.fighters) {
      if (f.dead) continue;
      if (f.ai) f.ai.think(this.fighters);   // AI writes f.aiIn for this step
      // Player fighters read their sampled input; AI fighters (mooks) carry
      // their own fabricated input dict on f.aiIn (same shape as keyboard).
      const inp = f.inputKey ? this.lastIn[f.inputKey] : (f.aiIn || {});
      f.update(inp);
    }
    if (this.eng) this.eng.tick();   // handoff cooldown pace
    this.resolveHits();
    this.separateBodies();
  }

  resolveHits() {
    // Attack-box x every-other-fighter. One-hit-per-swing stays GLOBAL
    // (hitConfirmed): a swing connects with at most one target — right for
    // mook jabs; multi-target heavies become a per-attack flag later.
    const check = (attacker, defender) => {
      if (!attacker.hitboxes.length || defender.dead) return;
      const dRect = {
        x: defender.sprite.x - CFG.body.width / 2,
        y: defender.sprite.y - CFG.body.height / 2,
        w: CFG.body.width, h: CFG.body.height,
      };
      for (const hb of attacker.hitboxes) {
        if (this.overlaps(hb, dRect)) {
          defender.takeHit(hb, attacker.facing);
          attacker.hitConfirmed = true;
          this.onHitFeedback(hb);
          break;
        }
      }
    };
    for (const a of this.fighters) {
      if (a.dead) continue;
      for (const d of this.fighters) {
        if (d === a) continue;
        check(a, d);
      }
    }
  }

  overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  onHitFeedback(hb) {
    // Knockback-scaled shake.
    this.shakeT = 0.12;
    this.shakeMag = Math.min(14, 3 + hb.damage * 0.6);
  }

  // Body-block: fighters can't occupy the same space. Push apart AND kill
  // drive-into-contact velocity (option 2: hitting the opponent slows the
  // TRUE speed, so a blocked runner really stops instead of running in place
  // — the gait, being a function of real speed, then falls to idle on its
  // own; wallContact also freezes the stride phase to kill 1-frame lag).
  // Pairwise over the roster: O(n^2) but trivial below ~50 bodies; a spatial
  // grid is the answer if crowds ever get that big.
  separateBodies() {
    const fs = this.fighters;
    const intent = (f) => (f.inputKey && this.lastIn[f.inputKey]) || (f.aiIn) || {};
    for (const f of fs) { f.wallContact = false; f.wallBlockDir = 0; }
    for (let i = 0; i < fs.length; i++) {
      if (fs[i].dead) continue;
      for (let j = i + 1; j < fs.length; j++) {
        if (fs[j].dead) continue;
        const a = fs[i].sprite, b = fs[j].sprite;
        const dx = b.x - a.x;
        const overlap = CFG.body.width - Math.abs(dx);
        const vertical = Math.abs(a.y - b.y) < CFG.body.height;
        // STICKY touch (3px slop — push-apart equilibrium sits ~1px past
        // true contact; exact overlap flickered the flag and restart-accel
        // stuttered). Press-intent keeps the wall true while leaning.
        const touching = overlap > -3 && vertical;
        const dir = dx >= 0 ? 1 : -1;
        const inA = intent(fs[i]), inB = intent(fs[j]);
        if (touching) {
          // Accumulate OR: pressed by ANYbody counts as wall contact.
          if (inA.heldDir === dir)  { fs[i].wallContact = true; fs[i].wallBlockDir = dir; }
          if (inB.heldDir === -dir) { fs[j].wallContact = true; fs[j].wallBlockDir = -dir; }
          if (overlap > 0) {
            const push = overlap / 2 + 0.5;
            // Momentum-preserving separation (never body.reset, which zeroes vx):
            a.x -= dir * push;
            b.x += dir * push;
            // Kill only velocity driving INTO the other; knockback pointing
            // away, dash-aways and jukes survive untouched.
            if (dir * a.body.velocity.x > 0) a.body.setVelocityX(0);
            if (-dir * b.body.velocity.x > 0) b.body.setVelocityX(0);
            a.body.updateFromGameObject();
            b.body.updateFromGameObject();
          }
        }
      }
    }
  }

  makeLabels() {
    this.labels = [
      this.add.text(44, 54, 'P1  A/D Space Shift  J K  (W/S+atk)', { fontFamily: 'monospace', fontSize: '13px', color: '#8fa0c8' }),
      this.add.text(1236 - 220, 54, 'P2  Arrows / , .', { fontFamily: 'monospace', fontSize: '14px', color: '#8fa0c8' }),
    ];
    for (const t of this.labels) t.setScrollFactor(0);
  }

  // ---- Camera (render side only — the sim never reads it) ----
  // duel mode: centre on the midpoint of the fighters, zoomed out if they're
  //   far apart (classic FG cam, future boss cam).
  // follow mode: centre on P1 with facing lookahead (mook-carving cam).
  // Eased on render delta so 60 and 144 Hz feel identical; clamped by the
  // camera bounds Phaser enforces against the world.
  updateCamera() {
    const W = 1280, H = 720;
    let target;
    if (this.camMode === 'follow') {
      const look = this.p1.facing * 110;               // see what you run into
      target = this.p1.sprite.x + look;
    } else {
      const mid = (this.p1.sprite.x + this.p2.sprite.x) / 2;
      target = mid;
      // FG cam: don't let one fighter walk out of frame — clamp so both stay
      // visible when they're within a screen, else follow the midpoint.
      const span = Math.abs(this.p1.sprite.x - this.p2.sprite.x);
      if (span < W - 160) {
        const lo = Math.min(this.p1.sprite.x, this.p2.sprite.x) + (W - 160) / 2;
        const hi = Math.max(this.p1.sprite.x, this.p2.sprite.x) - (W - 160) / 2;
        target = (target < lo) ? lo : (target > hi ? hi : target);
      }
    }
    // Ease (rate normalised to 60 Hz; frame-rate independent).
    const r = Math.min(1, (this.game.loop.delta / 1000) * 9);
    if (this.camX === null) this.camX = target;
    this.camX += (target - this.camX) * r;

    // Shake decays on the fixed step (feels the same regardless of fps).
    let sx = 0, sy = 0;
    if (this.shakeT > 0) {
      this.shakeT -= SIM_STEP;
      sx = (Math.random() - 0.5) * this.shakeMag;
      sy = (Math.random() - 0.5) * this.shakeMag;
    }
    // centre -> scroll. Use setScroll (NOT scrollX=): setScroll clamps to the
    // camera bounds; the raw property bypasses clamping (screen-edge gaps).
    this.cameras.main.setScroll(this.camX - W / 2 + sx, sy);
  }

  renderAll() {
    for (const f of this.fighters) { if (!f.dead) f.render(); }
    this.updateCamera();

    // HUD health bars.
    const g = this.hud;
    g.clear();
    const barW = 460, barH = 22, pad = 40;
    // P1 (left, drains right-to-left).
    g.fillStyle(0x000000, 0.55); g.fillRect(pad - 4, 28 - 4, barW + 8, barH + 8);
    g.fillStyle(0x22282e, 1); g.fillRect(pad, 28, barW, barH);
    g.fillStyle(0xf2b705, 1); g.fillRect(pad, 28, barW * this.p1.health / 100, barH);
    // P2 (right, drains left-to-right). In arena mode: mook counter instead.
    const rx = 1280 - pad - barW;
    const liveMooks = this.fighters.filter(f => f.ai && !f.dead).length;
    if (this.mookCount > 0 && liveMooks > 0) {
      g.fillStyle(0x000000, 0.55); g.fillRect(rx - 4, 28 - 4, barW + 8, barH + 8);
      g.fillStyle(0x22282e, 1); g.fillRect(rx, 28, barW, barH);
      g.fillStyle(0xff8f5a, 1); g.fillRect(rx + barW - barW * liveMooks / Math.max(1, this.mookCount), 28,
        barW * liveMooks / Math.max(1, this.mookCount), barH);
      if (!this.mookLabel) {
        this.mookLabel = this.add.text(rx + 8, 30, '', { fontFamily: 'monospace', fontSize: '15px', color: '#0b0b10' });
        this.mookLabel.setScrollFactor(0);
      }
      this.mookLabel.setText('MOOKS ' + liveMooks).setX(rx + 8);
    } else if (this.mookCount === 0) {
      g.fillStyle(0x000000, 0.55); g.fillRect(rx - 4, 28 - 4, barW + 8, barH + 8);
      g.fillStyle(0x22282e, 1); g.fillRect(rx, 28, barW, barH);
      const w2 = barW * this.p2.health / 100;
      g.fillStyle(0xff5a5a, 1); g.fillRect(rx + barW - w2, 28, w2, barH);
    }
    // Labels.
    this.labels || this.makeLabels();
  }
}

window.__GAME = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: 1280,
  height: 720,
  backgroundColor: '#08080c',
  physics: { default: 'arcade', arcade: { debug: false } },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: FightScene,
});