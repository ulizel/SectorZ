import { describe, it, expect, beforeAll } from 'vitest';
import { initPhysics, PhysicsWorld } from '../src/physics/physicsWorld';
import { Player } from '../src/entities/player';
import { UPGRADES, rollUpgrades } from '../src/systems/upgrades';
import { WEAPONS } from '../src/weapons/weapon';
import { AimModel } from '../src/weapons/aimModel';
import { rng } from '../src/core/math';

beforeAll(async () => { await initPhysics(); });
const target = () => ({ player: new Player(1, new PhysicsWorld(), 0, 0), grenadeRadiusMul: 1 });
const up = (id: string) => UPGRADES.find((u) => u.id === id)!;

describe('upgrades', () => {
  it('weapon upgrades change only this run\'s weapon copies, never the base WEAPONS', () => {
    const t = target();
    up('damage').apply(t); up('rate').apply(t); up('mags').apply(t);
    expect(t.player.weapons[0].def.damage).toBeCloseTo(WEAPONS.pistol.damage * 1.2);
    expect(t.player.weapons[1].def.fireInterval).toBeCloseTo(WEAPONS.smg.fireInterval / 1.12);
    expect(t.player.weapons[2].def.magSize).toBe(Math.ceil(WEAPONS.shotgun.magSize * 1.3));
    expect(WEAPONS.pistol.damage).toBe(25);
  });

  it('player upgrades: max health, speed, grenades', () => {
    const t = target();
    up('health').apply(t); up('speed').apply(t); up('demo').apply(t);
    expect(t.player.maxHealth).toBe(125);
    expect(t.player.speedMul).toBeCloseTo(1.1);
    expect(t.player.grenadeMax).toBe(6);
    expect(t.grenadeRadiusMul).toBeCloseTo(1.15);
  });

  it('offers 3 different cards, never one already maxed, and medic only when hurt', () => {
    const t = target();
    const taken = new Map([['damage', 5]]);
    for (let s = 1; s < 30; s++) {
      const list = rollUpgrades(t, taken, 3, rng(s));
      expect(list).toHaveLength(3);
      expect(new Set(list.map((u) => u.id)).size).toBe(3);
      expect(list.some((u) => u.id === 'damage' || u.id === 'medic')).toBe(false);
    }
    t.player.health = 30;
    expect(Array.from({ length: 40 }, (_, s) => rollUpgrades(t, taken, 3, rng(s + 1))).some((l) => l.some((u) => u.id === 'medic'))).toBe(true);
  });
});

describe('pistol vertical recoil', () => {
  it('quick follow-up shots climb (toward the head), then it settles', () => {
    const a = new AimModel();
    a.onShot(WEAPONS.pistol);
    const one = a.pitch;
    a.updateBloom(WEAPONS.pistol, 0, 0.2); a.onShot(WEAPONS.pistol);
    expect(a.pitch).toBeGreaterThan(one);
    for (let i = 0; i < 120; i++) a.updateBloom(WEAPONS.pistol, 0, 1 / 60);
    expect(a.pitch).toBeLessThan(0.005);
    const s = new AimModel(); s.onShot(WEAPONS.smg);
    expect(s.pitch).toBe(0); // only the pistol kicks up
  });
});
