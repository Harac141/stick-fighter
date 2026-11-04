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
          // CENTER = x + box.x + w/2 (see __KFAUDIT comment: box.x is the
          // LEFT-edge offset, box.y is the center height).
          const ccx = cx + fac * (bx.x + bx.w / 2), ccy = cy - 46 + bx.y;
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

// ---- Download the whole sheet as a single PNG sprite sheet (user request).
document.getElementById('dl').onclick = () => {
  const cv = document.querySelector('#sheet canvas');
  const a = document.createElement('a');
  a.download = 'stickfight-keyframes.png';
  a.href = cv.toDataURL('image/png');
  a.click();
};

// ---- THE VERIFIER (user: "when I identify something and tell you to fix
// it, you don't know when it's fixed"). __KFAUDIT() answers that in numbers,
// so a claimed fix can be CONFIRMED, not vibe-checked. Two parts per move:
//  (A) LIMB-ON-BOX: the striking limb (atk.limb, default fist handB / kick
//      footB — computePose flips local F/B) must sit INSIDE the damage box
//      on at least one active frame, and report its worst distance. Vision
//      once blessed a kick whose heel passed 20-30px UNDER its own box;
//      this catches that class exactly.
//  (B) PIXEL: cyan box pixels must exist on exactly the publishing frames
//      (mirrors tickAttack: plain window, hitFrames pairs, gun fire frame).
// Gate: every damaging move passes (A) and every frame passes (B).
window.__KFAUDIT = () => {
  const A = Fighter.CFG.attacks;
  const cv = document.querySelector('#sheet canvas');
  const ctx = cv.getContext('2d');
  const TOP=46, ROW_H=138, CELL_W=92, CELL_H=122;
  const rows = [];
  function activeBox(atk, f) {
    if (atk.hitFrames) { for (const hf of atk.hitFrames) if (f>=hf && f<=hf+1) return true; return false; }
    if (atk.fire) return f === (atk.aimLock||atk.startup)+1;
    return f>atk.startup && f<=atk.startup+atk.active;
  }
  const list = [['jab',0],['jab1',0],['jab2',0],['heavy',0],['sidekick',0],
                ['uppercut',0],['uppercutH',0],['sweep',0],['hammerfist',0],
                ['axekick',1],['airjab',1],['dashatk',0],['katLight',0],['katHeavy',0],['shoot',0]];
  const scene = window.__KF.scene.getScene('sheet');
  let allPass = true;
  list.forEach(([name, air], rI) => {
    const atk = A[name]; if (!atk) { rows.push({name, fail:'missing'}); allPass=false; return; }
    const total = atk.startup + atk.active + atk.recovery + (atk.fire?1:0);
    // (A) limb-on-box (guns aim-and-fire: no limb check)
    let limbOk = 'n/a', worstD = null;
    if (!atk.fire && atk.box) {
      // computePose FLIPS F/B: pose.footA = LOCAL footB, pose.footB = LOCAL
      // footF. sweep/axe extend the LOCAL FRONT foot (-> pose.footB, the same
      // mapping main.js's chop streak uses); sidekick kicks with the LOCAL
      // REAR foot (-> pose.footA) and says so via atk.limb. AUTO default =
      // footB (the common case); atk.limb overrides. (This flip bit the
      // verifier too: auditing the sweep's REAR planted leg gave dx=65.)
      const kick = (atk.pose==='sweep'||atk.pose==='axe'||atk.pose==='sidekick');
      const key = atk.limb || (kick ? 'footB' : 'handB');
      let hit = false, worst = 1e9, cand = [];
      for (let f=atk.startup+1; f<=atk.startup+atk.active + (atk.hitFrames?2:0); f++) {
        if (!activeBox(atk, f)) continue;
        const p = new Fighter(scene, 400, 500, 1, 0xffffff);
        p.state='attack'; p.currentAttack=name; p.attackFrame=f;
        if (air){ p.airborne=true; p.body.velocity.y=120; }
        const q = p.computePose(400,500);
        const limb = q[key]; if (!limb) continue;
        const bcx = 400 + atk.box.x + atk.box.w/2, bcy = (500 - 46) + atk.box.y;
        const dx = Math.abs(limb.x-bcx), dy = Math.abs(limb.y-bcy);
        worst = Math.min(worst, Math.hypot(dx, dy));
        cand.push({ f, dx, dy, reach: Math.hypot(limb.x-q.hip.x, limb.y-q.hip.y) });
      }
      // NOT "inside on ANY active frame": a mis-heighted limb TRANSITS the
      // box corner (the heel-low bug slipped through that rule). The strike
      // must land on the box AT FULL EXTENSION — the frame where the limb is
      // farthest from the hip (max reach): every strike's whole point is that
      // frame, and a clip mid-flight is not contact.
      if (cand.length) {
        const ext = cand.reduce((a,b) => b.reach > a.reach ? b : a);
        hit = ext.dx <= atk.box.w/2 + 18 && ext.dy <= atk.box.h/2 + 12;
      }
      limbOk = hit ? 'pass' : 'FAIL'; worstD = +worst.toFixed(1);
      if (!hit) allPass = false;
    }
    // (B) pixel audit vs publish rules
    let pixFail = 0;
    const rowStart = TOP + rI*ROW_H, gy = rowStart + CELL_H - 18;
    for (let f=1; f<=total; f++) {
      const cx = 30 + (f-1)*CELL_W + CELL_W/2 - 4;
      let cyan = 0;
      if (atk.box) {
        // THE sheet's box rect — and THE ONLY correct one (attackWorldBox:
        // facing 1 -> LEFT edge at x+box.x, so CENTER is x+box.x+w/2; box.y
        // IS the center height). Drawing/auditing at x+box.x (edge-as-center)
        // shifted every box ~w/2 LEFT and would have tuned poses to a lie.
        const bx = atk.box, ccx = cx + bx.x + bx.w/2, ccy = gy - 46 + bx.y;
        const x0=Math.max(0,Math.floor(ccx-bx.w/2-1)), y0=Math.max(0,Math.floor(ccy-bx.h/2-1));
        const x1=Math.min(cv.width,Math.ceil(ccx+bx.w/2+1)), y1=Math.min(cv.height,Math.ceil(ccy+bx.h/2+1));
        const d = ctx.getImageData(x0,y0,x1-x0,y1-y0).data;
        for (let p=0;p<d.length;p+=4) if (d[p]<120 && d[p+1]>150 && d[p+2]>200) cyan++;
      }
      const exp = activeBox(atk,f);
      if (exp !== (cyan > 5)) pixFail++;      // thin-stroke AA: >5 not >15
    }
    if (pixFail) allPass = false;
    rows.push({name, limb: limbOk, minDistToBox: worstD, pixelFrameFails: pixFail});
  });
  return { pass: allPass, rows };
};
