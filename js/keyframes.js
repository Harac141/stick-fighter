// keyframes.js — full-move sprite sheet: EVERY sim frame of every attack,
// laid out like a sprite sheet, one row per move.
//
// Why this exists (user: "render out key frames and view them all at once"):
// animlab samples 8 phases per move; this shows the TRUE frame count —
// startup/active/recovery at 1 cell per sim step — with the damage box
// drawn under exactly the frames that publish it (mirrors tickAttack/_hitOut
// rules: plain = (startup, startup+active]; hitFrames = 2-frame window each;
// guns = fire frame). Pose source is computePose (the live target) — the
// game's blendPose lags it ~2 frames, so compare MOTION, not exact frames.
//
// Dev-loop role: this is the audit view. Tune CFG.poseX live (see animlab's
// __LABCFG bridge — same lexical-context reason applies here, so this file
// exports __KFCFG/__KFRESET too), then screenshot/download ONE PNG to review.

const KF_MOVES = [
  // name                air?  (air:true rows get airborne legs like animlab)
  ['jab', false], ['jab1', false], ['jab2', false],
  ['heavy', false], ['sidekick', false],
  ['uppercut', false], ['uppercutH', false],
  ['sweep', false], ['hammerfist', false], ['axekick', true],
  ['airjab', true], ['dashatk', false],
  ['katLight', false], ['katHeavy', false],
  ['shoot', false],
];

const CELL_W = 92, CELL_H = 122, ROW_H = 138, TOP = 46;
// Width fits the LONGEST move (uppercutH ~26 frames): compute maxTotal over
// the active list so no row clips (a clipped keyframe sheet defeats the point).
function kfMaxCols(list) {
  let m = 1;
  for (const [name] of list) {
    const a = Fighter.CFG.attacks[name];
    if (a) m = Math.max(m, a.startup + a.active + a.recovery + (a.fire ? 1 : 0));
  }
  return m;
}

// Publish rules copied from Fighter.tickAttack/_hitOut (single source of
// truth comment lives there — update BOTH if hitbox timing changes).
function kfActiveBox(atk, f) {
  if (atk.hitFrames) {
    for (const hf of atk.hitFrames) if (f >= hf && f <= hf + 1) return true;
    return false;
  }
  if (atk.fire) return f === (atk.aimLock || atk.startup) + 1;
  return f > atk.startup && f <= atk.startup + atk.active;
}

class SheetScene extends Phaser.Scene {
  constructor() { super('sheet'); }

  create() {
    const moves = window.__KF_LIST || KF_MOVES;
    let y = TOP;
    for (const [name, air] of moves) {
      const atk = Fighter.CFG.attacks[name];
      if (!atk) { y += ROW_H; continue; }
      const total = atk.startup + atk.active + atk.recovery + (atk.fire ? 1 : 0);

      // Row header: name + the frame data the sheet is checking against.
      this.add.text(12, y - 22, `${name}  s${atk.startup}/a${atk.active}/r${atk.recovery}` +
        `  dmg${atk.damage}` + (atk.hitFrames ? ' x' + atk.hitFrames.length : '') +
        (atk.fire ? ' GUN' : ''),
        { fontFamily: 'monospace', fontSize: '12px', color: '#8fa0c8' });
      // Phase strip: one tick per sim frame, coloured by phase.
      for (let f = 1; f <= total; f++) {
        const ph = atk.fire ? (f === total ? 'a' : (f <= atk.startup ? 's' : 'r'))
          : (f <= atk.startup ? 's' : (f <= atk.startup + atk.active ? 'a' : 'r'));
        const col = ph === 'a' ? 0xf2b705 : (ph === 's' ? 0x3fd6b6 : 0x3a4560);
        const g = this.add.graphics();
        g.fillStyle(col, 1); g.fillRect(30 + (f - 1) * CELL_W, y - 10, CELL_W - 8, 3);
      }

      for (let f = 1; f <= total; f++) {
        const cx = 30 + (f - 1) * CELL_W + CELL_W / 2 - 4;
        const cy = y + CELL_H - 18;                       // ground line for this row
        const fac = 1;
        const fl = new Fighter(this, cx, cy, fac, 0xffffff);

        const isActive = kfActiveBox(atk, f);
        // Pose from the SAME code the game runs (target pose, pre-blend).
        fl.state = 'attack';
        fl.currentAttack = name;
        fl.attackFrame = f;
        fl.facing = fac;
        if (air) { fl.airborne = true; fl.body.velocity.y = 120; }
        const pose = fl.computePose(cx, cy);

        const g = fl.gfx;
        const ink = isActive ? 0xffffff : 0x5a6a92;
        g.lineStyle(3, ink, 1);
        g.strokeCircle(pose.head.x, pose.head.y, 12);
        const seg = (a, b) => g.lineBetween(a.x, a.y, b.x, b.y);
        seg(pose.neck, pose.hip);
        seg(pose.neck, pose.elbowA); seg(pose.elbowA, pose.handA);
        seg(pose.neck, pose.elbowB); seg(pose.elbowB, pose.handB);
        seg(pose.hip, pose.kneeA); seg(pose.kneeA, pose.footA);
        seg(pose.hip, pose.kneeB); seg(pose.kneeB, pose.footB);

        // Ground + frame number.
        g.lineStyle(1, 0x445577, 0.7); g.lineBetween(cx - 38, cy, cx + 38, cy);
        // The damage box, truthfully (cyan). Center = body center above feet.
        if (isActive && atk.box) {
          const bx = atk.box;
          const ccx = cx + fac * bx.x, ccy = cy - 46 + bx.y;   // 46 = body.height/2
          g.lineStyle(1.5, 0x39d0ff, 0.95);
          g.strokeRect(ccx - bx.w / 2, ccy - bx.h / 2, bx.w, bx.h);
          g.fillStyle(0x39d0ff, 0.12);
          g.fillRect(ccx - bx.w / 2, ccy - bx.h / 2, bx.w, bx.h);
          if (atk.guard) {                                      // katana guard window
            const gb = atk.guard, gx = cx + fac * gb.x, gy = cy - 46 + gb.y;
            g.lineStyle(1, 0xffb060, 0.8);
            g.strokeRect(gx - gb.w / 2, gy - gb.h / 2, gb.w, gb.h);
          }
        }
        if (atk.fire && f === (atk.aimLock || atk.startup) + 1) {
          // muzzle marker at the fire frame
          g.fillStyle(0xffdd55, 1); g.fillCircle(cx + fac * (atk.fire.y ? 30 : 26), cy - 60, 3);
        }
        this.add.text(cx - 16, cy + 2, 'f' + f, { fontFamily: 'monospace', fontSize: '10px',
          color: isActive ? '#f2b705' : '#44557b' });
      }
      y += ROW_H;
    }
    window.__KF_READY = true;
  }
}

const KF_LIST = window.__KF_LIST || KF_MOVES;
const KF_W = 30 + kfMaxCols(KF_LIST) * CELL_W + 30;
const KF_H = TOP + KF_LIST.length * ROW_H + 20;
window.__KF = new Phaser.Game({
  type: Phaser.CANVAS,
  parent: 'sheet',
  width: KF_W,
  height: KF_H,
  backgroundColor: '#08080c',
  physics: { default: 'arcade', arcade: { debug: false } },
  scene: SheetScene,
});

// ---- Live tuning bridges (same reason as animlab's __LABCFG: CDP evals are
// a separate script context and cannot see lexical Fighter/CFG). ----
window.__KFCFG = Fighter.CFG;
window.__KFRESET = () => { window.__KF_READY = false;
  window.__KF.scene.getScene('sheet').scene.restart(); };
// __KFSET([['sidekick',false],['heavy',false]]) then __KFRESET() = one-move sheet.

// Download the whole sheet as a single PNG sprite sheet (user request).
document.getElementById('dl').onclick = () => {
  const cv = document.querySelector('#sheet canvas');
  const a = document.createElement('a');
  a.download = 'stickfight-keyframes.png';
  a.href = cv.toDataURL('image/png');
  a.click();
};
