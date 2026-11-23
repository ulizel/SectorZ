import { describe, it, expect } from 'vitest';
import { WeaponState, WEAPONS, type WeaponEvent } from '../src/weapons/weapon';

const DT = 1 / 60;
function run(w: WeaponState, seconds: number, trigger: boolean, out: WeaponEvent[][] = []) {
  const ev: WeaponEvent[] = [];
  for (let t = 0; t < seconds; t += DT) { w.update(DT, trigger, false, ev); out.push([...ev]); }
  return out.flat();
}

describe('WeaponState (pistol)', () => {
  it('fires at the configured rate while held', () => {
    const w = new WeaponState(WEAPONS.pistol);
    const ev = run(w, 1.0, true);
    const shots = ev.filter((e) => e === 'fired').length;
    // 0.2s interval → 5 shots in 1s (first shot immediate).
    expect(shots).toBeGreaterThanOrEqual(5);
    expect(shots).toBeLessThanOrEqual(6);
    expect(w.ammo).toBe(WEAPONS.pistol.magSize - shots);
  });

  it('auto-reloads when the magazine empties and refills', () => {
    const w = new WeaponState(WEAPONS.pistol);
    const ev = run(w, 12 * 0.2 + 0.1, true);
    expect(ev.filter((e) => e === 'fired').length).toBe(12);
    expect(ev).toContain('reloadStart');
    expect(w.reloading).toBe(true);
    run(w, WEAPONS.pistol.reloadTime + 0.05, false);
    expect(w.reloading).toBe(false);
    expect(w.ammo).toBe(12);
  });

  it('cannot fire while reloading and manual reload only when not full', () => {
    const w = new WeaponState(WEAPONS.pistol);
    const ev: WeaponEvent[] = [];
    w.update(DT, false, true, ev);
    expect(ev).toEqual([]); // full mag: no reload
    w.update(DT, true, false, ev); // fire one
    w.update(DT, false, true, ev);
    expect(ev).toContain('reloadStart');
    w.update(DT, true, false, ev);
    expect(ev).not.toContain('fired');
  });
});
