import { describe, it, expect } from 'vitest';
import { AimModel } from '../src/weapons/aimModel';
import { WEAPONS } from '../src/weapons/weapon';

const DT = 1 / 60;
const turnTicks = (from: number, to: number, mag: number, def = WEAPONS.pistol) => {
  const a = new AimModel();
  a.angle = from;
  let n = 0;
  while (a.errorTo(to) > 0.01 && n < 600) { a.turnToward(to, mag, def, DT); n++; }
  return n;
};

describe('AimModel', () => {
  it('is not instant, but a big flick arrives quickly', () => {
    const n = turnTicks(0, Math.PI * 0.9, 1);
    expect(n).toBeGreaterThan(10); // > 0.16 s: has weight
    expect(n).toBeLessThan(45); // < 0.75 s: still responsive
  });

  it('turns fast when far, slow when close (settles gently)', () => {
    const a = new AimModel();
    a.turnToward(2, 1, WEAPONS.pistol, DT);
    const far = a.angularVel;
    const b = new AimModel();
    b.turnToward(0.1, 1, WEAPONS.pistol, DT);
    expect(far).toBeGreaterThan(b.angularVel * 3);
  });

  it('a light stick push aims slower than a full push (fine control)', () => {
    expect(turnTicks(0, 1.5, 0.1)).toBeGreaterThan(turnTicks(0, 1.5, 1) * 1.8);
  });

  it('heavier weapons turn slower', () => {
    expect(turnTicks(0, 2.5, 1, WEAPONS.smg)).toBeGreaterThan(turnTicks(0, 2.5, 1, WEAPONS.pistol));
  });

  it('takes the short way round', () => {
    const a = new AimModel();
    a.angle = 3;
    a.turnToward(-3, 1, WEAPONS.pistol, DT);
    expect(a.angle).toBeGreaterThan(3);
  });

  it('accuracy blooms when moving/turning/firing and settles when steady', () => {
    const a = new AimModel();
    const def = WEAPONS.pistol;
    expect(a.spread(def)).toBeCloseTo(def.spread);
    a.onShot(def);
    for (let i = 0; i < 10; i++) a.updateBloom(def, 1, DT); // running
    const bloomed = a.spread(def);
    expect(bloomed).toBeGreaterThan(def.spread * 2);
    for (let i = 0; i < 120; i++) { a.hold(DT); a.updateBloom(def, 0, DT); }
    expect(a.spread(def)).toBeLessThan(def.spread * 1.1);
  });
});
