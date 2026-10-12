// main.js — scene: stage, players, fixed-step sim loop, hitbox resolution.
//
// Controls:
//   P1: A/D move, W jump, Shift dash, J jab, K heavy
//   P2: Arrows move/jump, / dash, , (comma) jab, . (period) heavy
//   F1: toggle hitbox/hurtbox debug view
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
    // Floor plane at groundY (620) so feet rest on the DRAWN floor line, not the canvas bottom.
    this.physics.world.setBounds(0, 0, W, this.groundY);
    this.physics.world.gravity.y = CFG.gravity;

    // ---- Stage art (drawn once) ----
    const bg = this.add.graphics();
    // Sky.
    bg.fillGradientStyle(0x101423, 0x101423, 0x1b2440, 0x1b2440, 1);
    bg.fillRect(0, 0, W, H);
    // Floor slab.
    bg.fillStyle(0x2a3050, 1);
    bg.fillRect(0, this.groundY, W, H - this.groundY);
    bg.lineStyle(3, 0x4a557e, 1);
    bg.lineBetween(0, this.groundY, W, this.groundY);
    // Back wall lanes for dojo depth.
    bg.lineStyle(1, 0x232b48, 1);
    for (let px = 100; px < W; px += 100) bg.lineBetween(px, 120, px, this.groundY);

    // ---- Fighters ----
    this.p1 = new Fighter(this, 420, this.groundY, 1, 0xf2f2f2);
    this.p2 = new Fighter(this, 860, this.groundY, -1, 0x9ad0ff);

    // ---- Input ----
    const kb = this.input.keyboard;
    kb.addCapture(Phaser.Input.Keyboard.KeyCodes.WASD);
    kb.addCapture(Phaser.Input.Keyboard.KeyCodes.ARROWS);
    kb.addCapture([Phaser.Input.Keyboard.KeyCodes.SHIFT,
                   Phaser.Input.Keyboard.KeyCodes.COMMA,
                   Phaser.Input.Keyboard.KeyCodes.PERIOD,
                   Phaser.Input.Keyboard.KeyCodes.SLASH,
                   Phaser.Input.Keyboard.KeyCodes.J,
                   Phaser.Input.Keyboard.KeyCodes.K]);
    this.keys = {
      p1: { left: kb.addKey('A'), right: kb.addKey('D'), jump: kb.addKey('W'),
            dash: kb.addKey('SHIFT'), jab: kb.addKey('J'), heavy: kb.addKey('K') },
      p2: { left: kb.addKey('LEFT'), right: kb.addKey('RIGHT'), jump: kb.addKey('UP'),
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

    // ---- Camera shake (hand-rolled: version-proof) ----
    this.shakeT = 0; this.shakeMag = 0; this.camBase = { x: 0, y: 0 };

    // ---- HUD ----
    this.hud = this.add.graphics();

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

  simStep() {
    const i1 = this.sampleInput('p1');
    const i2 = this.sampleInput('p2');
    this.p1.update(i1);
    this.p2.update(i2);
    this.resolveHits();
    this.separateBodies();
  }

  resolveHits() {
    const check = (attacker, defender) => {
      if (!attacker.hitboxes.length) return;
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
    check(this.p1, this.p2);
    check(this.p2, this.p1);
  }

  overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  onHitFeedback(hb) {
    // Knockback-scaled shake.
    this.shakeT = 0.12;
    this.shakeMag = Math.min(14, 3 + hb.damage * 0.6);
  }

  // Push apart when bodies overlap so fighters don't stack inside each other.
  separateBodies() {
    const a = this.p1.sprite, b = this.p2.sprite;
    const dx = b.x - a.x;
    const overlap = CFG.body.width - Math.abs(dx);
    if (overlap > 0 && Math.abs(a.y - b.y) < CFG.body.height) {
      const push = overlap / 2 + 0.5;
      const dir = dx >= 0 ? 1 : -1;
      // Move the game object, then resync the body. (body.reset() zeroes
      // velocity — that would murder momentum every time fighters touch.)
      a.x -= dir * push;
      b.x += dir * push;
      a.body.updateFromGameObject();
      b.body.updateFromGameObject();
    }
  }

  renderAll() {
    this.p1.render();
    this.p2.render();

    // Camera shake decay.
    if (this.shakeT > 0) {
      this.shakeT -= SIM_STEP;
      this.cameras.main.setScroll(
        (Math.random() - 0.5) * this.shakeMag,
        (Math.random() - 0.5) * this.shakeMag);
    } else {
      this.cameras.main.setScroll(0, 0);
    }

    // HUD health bars.
    const g = this.hud;
    g.clear();
    const barW = 460, barH = 22, pad = 40;
    // P1 (left, drains right-to-left).
    g.fillStyle(0x000000, 0.55); g.fillRect(pad - 4, 28 - 4, barW + 8, barH + 8);
    g.fillStyle(0x22282e, 1); g.fillRect(pad, 28, barW, barH);
    g.fillStyle(0xf2b705, 1); g.fillRect(pad, 28, barW * this.p1.health / 100, barH);
    // P2 (right, drains left-to-right).
    const rx = 1280 - pad - barW;
    g.fillStyle(0x000000, 0.55); g.fillRect(rx - 4, 28 - 4, barW + 8, barH + 8);
    g.fillStyle(0x22282e, 1); g.fillRect(rx, 28, barW, barH);
    const w2 = barW * this.p2.health / 100;
    g.fillStyle(0xff5a5a, 1); g.fillRect(rx + barW - w2, 28, w2, barH);
    // Labels.
    this.labels || this.makeLabels();
  }

  makeLabels() {
    this.labels = [
      this.add.text(44, 54, 'P1  A/D W Shift  J K', { fontFamily: 'monospace', fontSize: '14px', color: '#8fa0c8' }),
      this.add.text(1236 - 220, 54, 'P2  Arrows / , .', { fontFamily: 'monospace', fontSize: '14px', color: '#8fa0c8' }),
    ];
  }
}

// ---- Skid slider (DOM overlay; live-binds CFG.run.turnDecel) ----
// Low turnDecel = long skid, high = sharp stop. Slider runs 300..3000 inverted
// so dragging RIGHT = more skid (more intuitive than raw physics terms).
(function addSkidSlider() {
  const wrap = document.createElement('div');
  wrap.id = 'skid-ui';
  wrap.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:10px;'
    + 'z-index:10;font:13px monospace;color:#8fa0c8;background:rgba(8,8,12,0.75);'
    + 'padding:6px 12px;border-radius:8px;display:flex;gap:10px;align-items:center;user-select:none;';
  const label = document.createElement('span');
  label.textContent = 'skid';
  const slider = document.createElement('input');
  slider.type = 'range';
  // Controls RELEASE skid (friction): right = lower friction = longer slide.
  // 2400 = the old abrupt stop; 100 = ice-skate.
  slider.min = '100'; slider.max = '2400'; slider.step = '10';
  slider.value = String(2500 - Fighter.CFG.run.friction); // inverted: right = more skid
  slider.style.cssText = 'width:180px;accent-color:#f2b705;';
  const val = document.createElement('span');
  val.style.minWidth = '46px';
  const sync = () => {
    const friction = 2500 - Number(slider.value);
    Fighter.CFG.run.friction = friction;
    val.textContent = (friction === 2400) ? 'old' : (friction === 500 ? 'default' : String(friction));
  };
  slider.addEventListener('input', sync);
  sync();
  wrap.appendChild(label); wrap.appendChild(slider); wrap.appendChild(val);
  document.body.appendChild(wrap);
  window.__skidSlider = slider;
})();

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