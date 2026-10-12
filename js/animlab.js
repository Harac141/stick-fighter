// animlab.js — pose inspection harness.
// Draws a row of stick figures per state, sampled across the animation cycle.
// Usage: open animlab.html. Rows: idle, run (8 phases), jump, fall, dash,
// jab (8 phases across startup/active/recovery), heavy, hurt.
// The harness calls fighter.computePose directly, so it tests EXACTLY what
// the game renders.

class LabScene extends Phaser.Scene {
  constructor() { super('lab'); }

  create() {
    const COLS = 8, CELL_W = 120, CELL_H = 130;
    const rows = [
      { state: 'idle',  phase: () => 0.0 },
      { state: 'run',   phase: (i) => i / COLS },          // 8 phases of cycle
      { state: 'dash',  phase: () => 0.0, burst: true },   // burst = leap pose
      { state: 'dash',  phase: (i) => i / COLS },          // sprint = run cycle
      { state: 'jump',  phase: () => 0.0 },
      { state: 'fall',  phase: () => 0.0 },
      { state: 'attack', name: 'jab',   phase: (i) => i / COLS, total: 16 }, // jab total frames
      { state: 'attack', name: 'heavy', phase: (i) => i / COLS, total: 34 },
      { state: 'hurt',  phase: () => 0.0 },
      { state: 'attack', name: 'jab', phase: (i) => i / COLS, total: 10, whileMoving: true },
      { state: 'attack', name: 'heavy', phase: (i) => i / COLS, total: 34, whileMoving: true },
    ];

    let y = 40;
    for (const row of rows) {
      this.add.text(12, y - 20, `${row.state}${row.name ? ':' + row.name : ''}`,
        { fontFamily: 'monospace', fontSize: '12px', color: '#8fa0c8' });
      for (let i = 0; i < COLS; i++) {
        const cx = 30 + i * CELL_W;
        const cy = y + 100;
        const f = new Fighter(this, cx, cy, 1, 0xf2f2f2);
        f.state = row.state;
        if (row.name) { f.currentAttack = row.name; }
        // Drive animation time / attack frame from the phase.
        if (row.burst) f.dashTimer = 6;  // frozen mid-burst
        if (row.state === 'jump') f.airT = 0.08;   // tuck
        if (row.state === 'fall') f.airT = 0.92;   // reach
        if ((row.state === 'run' || row.whileMoving || (row.state === 'dash' && !row.burst)) && !row.burst) f.cyclePhase = row.phase(i);
        if (row.state === 'dash' && !row.burst) f.body.velocity.x = 450;
        if (row.burst) f.cyclePhase = 0.0;
        else if (row.state === 'idle') f.animTime = 0.5;
        else if (row.state === 'attack') {
          const atk = Fighter.CFG.attacks[row.name];
          const total = atk.startup + atk.active + atk.recovery;
          f.attackFrame = Math.max(1, Math.round(row.phase(i) * total));
          if (row.whileMoving) {
            f.cyclePhase = (i / COLS + 0.25) % 1;  // offset so legs differ per frame
            f.body.velocity.x = 250;               // fake run speed -> gaiting
          }
        }
        // Pose from the SAME code the game uses.
        const pose = f.computePose(cx, cy);
        const g = f.gfx;
        g.lineStyle(3, 0xf2f2f2, 1);
        g.strokeCircle(pose.head.x, pose.head.y, 12);
        g.lineBetween(pose.neck.x, pose.neck.y, pose.hip.x, pose.hip.y);
        g.lineBetween(pose.neck.x, pose.neck.y, pose.elbowA.x, pose.elbowA.y);
        g.lineBetween(pose.elbowA.x, pose.elbowA.y, pose.handA.x, pose.handA.y);
        g.lineBetween(pose.neck.x, pose.neck.y, pose.elbowB.x, pose.elbowB.y);
        g.lineBetween(pose.elbowB.x, pose.elbowB.y, pose.handB.x, pose.handB.y);
        g.lineBetween(pose.hip.x, pose.hip.y, pose.kneeA.x, pose.kneeA.y);
        g.lineBetween(pose.kneeA.x, pose.kneeA.y, pose.footA.x, pose.footA.y);
        g.lineBetween(pose.hip.x, pose.hip.y, pose.kneeB.x, pose.kneeB.y);
        g.lineBetween(pose.kneeB.x, pose.kneeB.y, pose.footB.x, pose.footB.y);
        // ground line + hip reference (foot-under-hip check)
        g.lineStyle(1, 0x445577, 0.6);
        g.lineBetween(cx - 45, cy, cx + 45, cy);
        g.lineStyle(1, 0x44aa66, 0.5);
        g.lineBetween(pose.hip.x, pose.hip.y, pose.hip.x, cy); // vertical from hip
      }
      y += CELL_H + 14;
    }
    window.__LAB_READY = true;
  }
}

window.__LAB = new Phaser.Game({
  type: Phaser.CANVAS,
  parent: 'lab',
  width: 8 * 120 + 40,
  height: 11 * 144 + 80,
  backgroundColor: '#08080c',
  physics: { default: 'arcade', arcade: { debug: false } },
  scene: LabScene,
});
