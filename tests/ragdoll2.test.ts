import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { initPhysics, PhysicsWorld, RAPIER, Group, groups, ALL } from '../src/physics/physicsWorld';
import { Zombie } from '../src/entities/zombie';
import { ZombieManager, type ImpactResult } from '../src/entities/zombieManager';
import { PART_INDEX } from '../src/rigs/humanoid';
import { SIM_DT } from '../src/config';
import { rng } from '../src/core/math';

beforeAll(async () => { await initPhysics(); });
const caps = { maxRagdolls: 12, maxLooseLimbs: 40, maxCorpses: 30, corpseLife: 999 };

function setup() {
  const p = new PhysicsWorld();
  p.world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0).setCollisionGroups(groups(Group.STATIC, ALL)));
  const m = new ZombieManager(p, caps);
  const impacts: ImpactResult[] = [];
  const run = (steps: number) => { for (let i = 0; i < steps; i++) { m.update(SIM_DT); p.step(); m.processImpacts(p.contactForces, SIM_DT, impacts); } };
  return { p, m, run, impacts };
}
/** Relative rotation of child vs parent (rest = identity). */
function rel(z: Zombie, child: number): THREE.Quaternion {
  const c = z.parts[child], par = z.parts[c.parent];
  const a = par.body.rotation(), b = c.body.rotation();
  return new THREE.Quaternion(a.x, a.y, a.z, a.w).invert().multiply(new THREE.Quaternion(b.x, b.y, b.z, b.w));
}
const hingeAngle = (z: Zombie, i: number) => { const q = rel(z, i); return 2 * Math.atan2(q.x, q.w); };

describe('ragdoll realism', () => {
  it('muscle tone: knees buckle as it dies (not a stiff plank)', () => {
    const { m, run } = setup();
    const z = m.spawn(0, 0, 0);
    run(5);
    z.kill(SIM_DT);
    run(30); // 0.5 s
    const knee = Math.max(hingeAngle(z, PART_INDEX.shinL), hingeAngle(z, PART_INDEX.shinR));
    expect(knee).toBeGreaterThan(0.4);
  });

  it('swing limits: arms never swing through the torso, even when blasted (5 fixed seeds)', () => {
    const realRandom = Math.random;
    try {
      for (const seed of [1, 2, 3, 4, 5]) {
        Math.random = rng(seed); // deterministic blast randomness → reproducible test
        const { m, run } = setup();
        const z = m.spawn(0, 0, 0);
        run(5);
        m.explode(0.3, 0.3, 0.3, 5, 20, 22, SIM_DT); // strong throw, arms stay attached
        let worst = 0;
        for (let s = 0; s < 180; s++) {
          run(1);
          for (const [i, sign] of [[PART_INDEX.upperArmL, 1], [PART_INDEX.upperArmR, -1]] as const) {
            if (z.parts[i].severed || !z.ragdoll) continue; // only physics poses (not the crawl animation)
            const q = rel(z, i);
            const tw = new THREE.Quaternion(0, q.y, 0, q.w).normalize();
            const sw = q.clone().multiply(tw.invert());
            const ang = 2 * Math.acos(Math.min(1, Math.abs(sw.w)));
            const zc = (sw.z * Math.sign(sw.w) / (Math.hypot(sw.x, sw.z) || 1)) * ang * sign; // inward = negative
            worst = Math.min(worst, zc);
          }
        }
        // Limit is -0.25 rad; arms folded across the chest read up to ~-0.7; through the body is < -1.
        expect(worst, `seed ${seed}`).toBeGreaterThan(-0.8);
      }
    } finally {
      Math.random = realRandom;
    }
  });

  it('corpse at rest freezes (fixed bodies), and wakes up when shot', () => {
    const { m, run } = setup();
    const z = m.spawn(0, 0, 0);
    run(5);
    z.kill(SIM_DT);
    run(420); // settles, or is frozen by the 6 s fallback
    expect(z.frozen).toBe(true);
    expect(z.parts[1].body.isFixed()).toBe(true);
    m.hit(z.parts[1].collider, 10, 0, 2, 5, 0, 0.3, 0, SIM_DT);
    expect(z.frozen).toBe(false);
    expect(z.parts[1].body.isDynamic()).toBe(true);
  });

  it('knocked down by a blast, then gets back up', () => {
    const { m, run } = setup();
    const z = m.spawn(0, 0, 0);
    run(5);
    m.explode(3, 0.3, 0, 5, 20, 20, SIM_DT); // survivable distance
    expect(z.state).toBe('knocked');
    run(60 * 5);
    expect(z.state).toBe('alive');
    expect(z.parts[PART_INDEX.head].body.translation().y).toBeGreaterThan(1.3);
  });

  it('shattered shoulder: arm dangles limp but stays attached while the zombie stands', () => {
    const { m, run } = setup();
    const z = m.spawn(0, 0, 0);
    run(5);
    m.hit(z.parts[PART_INDEX.upperArmL].collider, 25, 1, 0, 0, 0.3, 1.2, 0.2, SIM_DT);
    const ua = z.parts[PART_INDEX.upperArmL];
    expect(ua.dangling).toBe(true);
    expect(ua.joint).not.toBeNull();
    run(120);
    expect(z.state).toBe('alive');
    const shoulder = z.parts[PART_INDEX.torso].body.translation();
    const arm = ua.body.translation();
    expect(Math.hypot(arm.x - shoulder.x, arm.y - shoulder.y, arm.z - shoulder.z)).toBeLessThan(0.6); // still attached
  });

  it('environmental impact: a body slammed into a wall takes damage', () => {
    const { p, m, run, impacts } = setup();
    p.world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 2, 3).setTranslation(2, 2, 0).setCollisionGroups(groups(Group.STATIC, ALL)));
    const z = m.spawn(0, 0, 0);
    run(5);
    z.kill(SIM_DT);
    for (const part of z.parts) part.body.setLinvel({ x: 18, y: 1, z: 0 }, true);
    let maxF = 0;
    const hpBefore = z.parts.reduce((s, q) => s + (Number.isFinite(q.hp) ? q.hp : 0), 0);
    for (let i = 0; i < 40; i++) { run(1); for (const im of impacts) maxF = Math.max(maxF, im.force); }
    const hpAfter = z.parts.reduce((s, q) => s + (Number.isFinite(q.hp) ? q.hp : 0), 0);
    expect(maxF).toBeGreaterThan(4500);
    expect(hpAfter).toBeLessThan(hpBefore);
  });
});
