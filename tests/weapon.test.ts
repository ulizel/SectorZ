import { describe, it, expect } from 'vitest';
import { WeaponState, WEAPONS, type WeaponEvent } from '../src/weapons/weapon';

const DT = 1 / 60;
/** Run for `seconds` with the given trigger state; returns all events. */
function run(w: WeaponState, seconds: number, trigger: boolean, tap = false) {
  const ev: WeaponEvent[] = [];
  const all: WeaponEvent[] = [];
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { w.update(DT, trigger, tap && i === 0, false, ev); all.push(...ev); }
  return all;
}
const shots = (ev: WeaponEvent[]) => ev.filter((e) => e === 'fired').length;

describe('single-shot weapon (pistol)', () => {
  it('is single-shot', () => expect(WEAPONS.pistol.automatic).toBe(false));

  it('holding the trigger alone never fires (touch: aiming shows the line only)', () => {
    const w = new WeaponState(WEAPONS.pistol);
    expect(shots(run(w, 2, true))).toBe(0);
    expect(w.ammo).toBe(12);
  });

  it('each tap fires exactly one shot', () => {
    const w = new WeaponState(WEAPONS.pistol);
    expect(shots(run(w, 0.5, false, true))).toBe(1);
    expect(shots(run(w, 0.5, true, true))).toBe(1); // tap + held → still one
    expect(w.ammo).toBe(10);
  });

  it('a tap during cooldown is buffered briefly, not lost', () => {
    const w = new WeaponState(WEAPONS.pistol);
    const ev: WeaponEvent[] = [];
    w.update(DT, false, true, false, ev);
    expect(ev).toContain('fired');
    let fired = 0;
    // Tap again 0.1 s later (cooldown 0.2 s) → fires when cooldown ends.
    for (let i = 0; i < 6; i++) w.update(DT, false, false, false, ev);
    w.update(DT, false, true, false, ev);
    for (let i = 0; i < 12; i++) { w.update(DT, false, false, false, ev); fired += shots(ev); }
    expect(fired).toBe(1);
  });

  it('auto-reloads when empty and refills', () => {
    const w = new WeaponState(WEAPONS.pistol);
    let total = 0;
    for (let i = 0; i < 12; i++) total += shots(run(w, 0.25, false, true));
    expect(total).toBe(12);
    expect(w.reloading).toBe(true);
    expect(shots(run(w, 0.3, false, true))).toBe(0); // taps during reload are dropped
    run(w, WEAPONS.pistol.reloadTime, false);
    expect(w.ammo).toBe(12);
  });
});

describe('automatic weapon (SMG)', () => {
  it('fires continuously while held at the configured rate', () => {
    const w = new WeaponState(WEAPONS.smg);
    const n = shots(run(w, 1, true));
    const expected = Math.ceil(1 / WEAPONS.smg.fireInterval);
    expect(n).toBeGreaterThanOrEqual(expected - 1);
    expect(n).toBeLessThanOrEqual(expected + 1);
  });

  it('stops immediately when the trigger is released', () => {
    const w = new WeaponState(WEAPONS.smg);
    run(w, 0.5, true);
    const ammo = w.ammo;
    expect(shots(run(w, 1, false))).toBe(0);
    expect(w.ammo).toBe(ammo);
  });
});

describe('manual reload', () => {
  it('only when not full, and blocks firing', () => {
    const w = new WeaponState(WEAPONS.smg);
    const ev: WeaponEvent[] = [];
    w.update(DT, false, false, true, ev);
    expect(ev).toEqual([]);
    w.update(DT, true, false, false, ev);
    w.update(DT, false, false, true, ev);
    expect(ev).toContain('reloadStart');
    w.update(DT, true, false, false, ev);
    expect(ev).not.toContain('fired');
    w.cancelReload();
    expect(w.reloading).toBe(false);
  });
});

describe('active reload', () => {
  const press = (w: WeaponState) => { const ev: WeaponEvent[] = []; w.update(DT, false, false, true, ev); return ev; };
  it('pressing reload inside the sweet spot finishes instantly', () => {
    const w = new WeaponState(WEAPONS.pistol);
    w.ammo = 3;
    press(w);
    const [a, b] = WEAPONS.pistol.activeWindow;
    while (w.reloadProgress < (a + b) / 2) run(w, DT, false);
    const ev = press(w);
    expect(ev).toContain('activeReload');
    expect(w.reloading).toBe(false);
    expect(w.ammo).toBe(12);
  });
  it('pressing outside the sweet spot fumbles (+0.5 s) and allows only one try', () => {
    const w = new WeaponState(WEAPONS.pistol);
    w.ammo = 3;
    press(w);
    run(w, 0.1, false);
    const left = w.reloadLeft;
    expect(press(w)).toContain('reloadFumble');
    expect(w.reloadLeft).toBeGreaterThan(left + 0.4);
    expect(press(w)).not.toContain('activeReload');
  });
});

describe('reserve ammo', () => {
  it('reloading draws from reserve; empty reserve = no reload, dry clicks', () => {
    const w = new WeaponState(WEAPONS.smg);
    w.reserve = 10;
    w.ammo = 0;
    run(w, DT, true); // pulling the trigger on empty triggers the auto-reload
    run(w, WEAPONS.smg.reloadTime + 0.1, false);
    expect(w.ammo).toBe(10);
    expect(w.reserve).toBe(0);
    const ev = run(w, 2, true);
    expect(ev.filter((e) => e === 'fired').length).toBe(10);
    expect(w.ammo).toBe(0);
    expect(w.reloading).toBe(false);
    expect(ev).toContain('dry');
  });
  it('pickups add reserve up to the max; pistol is unlimited', () => {
    const w = new WeaponState(WEAPONS.smg);
    expect(w.addAmmo(1000)).toBe(WEAPONS.smg.reserveMax - WEAPONS.smg.reserveStart);
    expect(new WeaponState(WEAPONS.pistol).reserve).toBe(Infinity);
  });
});

describe('shotgun (shell reload)', () => {
  it('reloads one shell at a time and can fire mid-reload', () => {
    const w = new WeaponState(WEAPONS.shotgun);
    w.ammo = 0;
    const ev: WeaponEvent[] = [];
    w.update(DT, false, false, true, ev); // start reload
    expect(w.reloading).toBe(true);
    let shells = 0;
    for (let t = 0; t < WEAPONS.shotgun.reloadTime * 2.5; t += DT) { w.update(DT, false, false, false, ev); shells += ev.filter((e) => e === 'shellIn').length; }
    expect(shells).toBe(2);
    expect(w.ammo).toBe(2);
    expect(w.reloading).toBe(true); // still loading
    w.update(DT, false, true, false, ev); // tap fire mid-reload
    expect(ev).toContain('fired');
    expect(w.ammo).toBe(1);
    expect(w.reloading).toBe(false);
  });
  it('has 12 pellets', () => expect(WEAPONS.shotgun.pellets).toBe(12));
});
