import { describe, it, expect, beforeAll } from 'vitest';
import { initPhysics, PhysicsWorld, RAPIER, Group, groups, ALL } from '../src/physics/physicsWorld';
import { ZombieManager } from '../src/entities/zombieManager';
import { ZOMBIE_TYPES, EXPLODER } from '../src/entities/zombie';
import { ZombieAI, type AttackResult } from '../src/ai/zombieAI';
import { PART_INDEX } from '../src/rigs/humanoid';
import { SIM_DT } from '../src/config';
import { waveTuning, waveRoster } from '../src/systems/waves';

beforeAll(async () => { await initPhysics(); });

function setup() {
  const p = new PhysicsWorld();
  p.world.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.5, 30).setTranslation(0, -0.5, 0).setCollisionGroups(groups(Group.STATIC, ALL)));
  return { p, m: new ZombieManager(p, { maxRagdolls: 12, maxLooseLimbs: 40, maxCorpses: 30, corpseLife: 999 }) };
}

describe('zombie types', () => {
  it('a brute is physically bigger (colliders and pose scale together), a runner smaller', () => {
    const { p, m } = setup();
    const w = m.spawn(0, 0, 0), b = m.spawn(4, 0, 0, 'brute'), r = m.spawn(-4, 0, 0, 'runner');
    const head = (z: typeof w) => z.parts[PART_INDEX.head];
    const hy = (z: typeof w) => head(z).body.translation().y;
    const he = (z: typeof w) => head(z).collider.halfExtents()!.y;
    // (idle sway is random, so the animated head height only roughly follows the scale)
    expect(Math.abs(hy(b) / hy(w) - ZOMBIE_TYPES.brute.scale)).toBeLessThan(0.06);
    expect(he(b) / he(w)).toBeCloseTo(ZOMBIE_TYPES.brute.scale, 3);
    expect(hy(r)).toBeLessThan(hy(w));
    expect(b.hp).toBe(ZOMBIE_TYPES.brute.hp);
    expect(r.baseSpeed).toBeGreaterThan(w.baseSpeed * 1.8);
    p.free();
  });

  it('a shove that knocks a walker down only staggers a brute', () => {
    const { p, m } = setup();
    const w = m.spawn(0, 0, 0), b = m.spawn(4, 0, 0, 'brute');
    for (const z of [w, b]) {
      const t = z.parts[PART_INDEX.torso].body.translation();
      z.hit(PART_INDEX.torso, 10, 0, 0, -60, t.x, t.y, t.z, SIM_DT);
    }
    expect(w.state).toBe('knocked');
    expect(b.state).toBe('alive');
    p.free();
  });

  it('the same arm hit that tears a walker arm off leaves a brute arm on', () => {
    const { p, m } = setup();
    const w = m.spawn(0, 0, 0), b = m.spawn(4, 0, 0, 'brute');
    const i = PART_INDEX.forearmL;
    const sev = [w, b].map((z) => { const t = z.parts[i].body.translation(); return z.hit(i, 5, 0, 0, -25, t.x, t.y, t.z, SIM_DT); });
    expect(sev[0]).toBe(i);
    expect(sev[1]).toBe(-1);
    p.free();
  });

  it('an exploder walks up to the player and lights its fuse instead of attacking', () => {
    const { p, m } = setup();
    const ai = new ZombieAI(p, 40);
    const z = m.spawn(0, -5, 0, 'exploder');
    ai.alertAll([z]);
    const attacks: AttackResult[] = [];
    let hits = 0;
    for (let i = 0; i < 300 && z.fuse === undefined; i++) {
      ai.update(SIM_DT, { x: 0, z: 0, alive: true }, m.zombies, attacks);
      hits += attacks.length;
      m.update(SIM_DT); p.step();
    }
    expect(z.fuse).toBe(EXPLODER.fuse);
    expect(hits).toBe(0);
    expect(Math.hypot(z.x, z.z)).toBeLessThan(1.6);
    p.free();
  });

  it('each wave has a fixed, growing mix of specials spread through it', () => {
    const count = (r: string[], k: string) => r.filter((x) => x === k).length;
    const r1 = waveRoster(1, waveTuning(1).count), r3 = waveRoster(3, waveTuning(3).count);
    const r5 = waveRoster(5, waveTuning(5).count), r8 = waveRoster(8, waveTuning(8).count);
    expect(r1.every((k) => k === 'walker')).toBe(true);
    expect([count(r3, 'runner'), count(r3, 'exploder'), count(r3, 'brute')]).toEqual([1, 0, 0]);
    expect([count(r5, 'runner'), count(r5, 'exploder'), count(r5, 'brute')]).toEqual([3, 2, 1]);
    expect(count(r8, 'brute')).toBe(2);
    expect(waveRoster(5, waveTuning(5).count)).toEqual(r5); // deterministic
    expect(r5.indexOf('brute')).toBeGreaterThanOrEqual(r5.length / 2); // brutes come late
    expect(r5.length).toBe(waveTuning(5).count);
  });
});
