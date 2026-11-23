import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { initPhysics, PhysicsWorld, RAPIER, Group, groups, ALL } from '../src/physics/physicsWorld';
import { ZombieManager } from '../src/entities/zombieManager';
import { ZombieAI, type AttackResult } from '../src/ai/zombieAI';
import { PART_INDEX, HUMANOID } from '../src/rigs/humanoid';
import { WEAPONS } from '../src/weapons/weapon';
import { SIM_DT } from '../src/config';
import { rng } from '../src/core/math';

beforeAll(async () => { await initPhysics(); });

function setup() {
  const p = new PhysicsWorld();
  p.world.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.5, 30).setTranslation(0, -0.5, 0).setCollisionGroups(groups(Group.STATIC, ALL)));
  const m = new ZombieManager(p, { maxRagdolls: 12, maxLooseLimbs: 40, maxCorpses: 30, corpseLife: 999 });
  const ai = new ZombieAI(p, 40);
  ai.enabled = true;
  return { p, m, ai };
}
const rot = (b: RAPIER.RigidBody) => { const r = b.rotation(); return new THREE.Quaternion(r.x, r.y, r.z, r.w); };

describe('hit reactions (natural, not twitchy)', () => {
  /** Run 1.5 s of 12 rounds/s from the front (or no fire), with fixed randomness. Returns stats. */
  function burst(flinch: number, fire: boolean) {
    const real = Math.random;
    Math.random = rng(7);
    try {
      const { p, m, ai } = setup();
      const z = m.spawn(0, -4, 0);
      const at: AttackResult[] = [];
      const target = { x: 0, z: 20, alive: false }; // nobody to chase: isolate the reaction
      for (let i = 0; i < 30; i++) { ai.update(SIM_DT, target, m.zombies, at); m.update(SIM_DT); p.step(); }
      const z0 = z.z;
      const limbs = [PART_INDEX.torso, PART_INDEX.upperArmL, PART_INDEX.upperArmR, PART_INDEX.head, PART_INDEX.thighL];
      const prev = HUMANOID.map((_, i) => rot(z.parts[i].body));
      let maxStep = 0, shot = 0;
      for (let i = 0; i < 90; i++) {
        if (fire && i % 5 === 0) {
          const part = limbs[shot++ % limbs.length];
          m.hit(z.parts[part].collider, 0.01, 0, 0, -WEAPONS.smg.impulse, 0, 1.1, -4, SIM_DT, 1, flinch);
        }
        ai.update(SIM_DT, target, m.zombies, at); m.update(SIM_DT); p.step();
        for (const k of limbs) { const r = rot(z.parts[k].body); maxStep = Math.max(maxStep, r.angleTo(prev[k])); prev[k] = r; }
      }
      return { maxStep, pushedBack: z0 - z.z, underFire: z.underFire };
    } finally { Math.random = real; }
  }

  it('sustained SMG fire: no per-bullet snapping beyond normal walking motion, zombie is driven back', () => {
    const calm = burst(0, false);
    const fire = burst(WEAPONS.smg.flinch, true);
    // Per-bullet micro-kicks are wanted (sharp jolts, < ~7°/tick), but no teleport-snaps (old bug: ~0.2 rad in one tick).
    expect(fire.maxStep).toBeLessThan(calm.maxStep + 0.12);
    expect(fire.pushedBack - calm.pushedBack).toBeGreaterThan(0.15); // driven back by the fire
    expect(fire.underFire).toBeGreaterThan(0.4); // recognised as sustained fire (leans in, slows)
  });

  it('a single pistol hit gives a clear but smooth jolt that recovers', () => {
    const { p, m } = setup();
    const z = m.spawn(0, -4, 0);
    for (let i = 0; i < 10; i++) { m.update(SIM_DT); p.step(); }
    const rest = rot(z.parts[PART_INDEX.torso].body);
    m.hit(z.parts[PART_INDEX.torso].collider, 0.01, 0, 0, -WEAPONS.pistol.impulse, 0, 1.1, -4, SIM_DT, 1, WEAPONS.pistol.flinch);
    let peak = 0, firstTick = -1;
    for (let i = 0; i < 60; i++) {
      m.update(SIM_DT); p.step();
      const a = rot(z.parts[PART_INDEX.torso].body).angleTo(rest);
      if (i === 0) firstTick = a;
      peak = Math.max(peak, a);
    }
    expect(peak).toBeGreaterThan(0.12); // visible jolt
    expect(firstTick).toBeLessThan(peak * 0.6); // ramps in (spring), not an instant snap
    expect(rot(z.parts[PART_INDEX.torso].body).angleTo(rest)).toBeLessThan(peak * 0.5); // recovering
  });
});
