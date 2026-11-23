import { describe, it, expect, beforeAll } from 'vitest';
import { initPhysics, PhysicsWorld, RAPIER, Group, groups, ALL } from '../src/physics/physicsWorld';
import { ZombieManager } from '../src/entities/zombieManager';
import { ZombieAI, AI, type AttackResult } from '../src/ai/zombieAI';
import { PART_INDEX } from '../src/rigs/humanoid';
import { SIM_DT } from '../src/config';

beforeAll(async () => { await initPhysics(); });

function setup(walls: [number, number, number, number][] = []) {
  const p = new PhysicsWorld();
  p.world.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.5, 30).setTranslation(0, -0.5, 0).setCollisionGroups(groups(Group.STATIC, ALL)));
  for (const [x, z, hx, hz] of walls) p.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 1, hz).setTranslation(x, 1, z).setCollisionGroups(groups(Group.STATIC, ALL)));
  const m = new ZombieManager(p, { maxRagdolls: 12, maxLooseLimbs: 40, maxCorpses: 30, corpseLife: 999 });
  const ai = new ZombieAI(p, 40);
  const target = { x: 0, z: 0, alive: true };
  const attacks: AttackResult[] = [];
  const all: AttackResult[] = [];
  const run = (steps: number) => {
    for (let i = 0; i < steps; i++) {
      ai.update(SIM_DT, target, m.zombies, attacks);
      all.push(...attacks);
      m.update(SIM_DT); p.step();
    }
  };
  return { p, m, ai, target, run, all };
}

describe('zombie AI', () => {
  it('finds its way around a wall to reach the player', () => {
    // Wall between zombie (z=-8) and player (z=0), wider than direct sidestep.
    const { m, ai, target, run } = setup([[0, -4, 4, 0.3]]);
    const z = m.spawn(0, -8, 0);
    ai.alertAll(m.zombies);
    run(60 * 20);
    expect(Math.hypot(z.x - target.x, z.z - target.z)).toBeLessThan(AI.attackRange + 0.3);
  });

  it('never walks through walls', () => {
    const { m, ai, run } = setup([[0, -4, 4, 0.3]]);
    const z = m.spawn(0, -8, 0);
    ai.alertAll(m.zombies);
    for (let i = 0; i < 60 * 15; i++) {
      run(1);
      const inWall = Math.abs(z.x) < 4 + 0.05 && Math.abs(z.z + 4) < 0.3 + 0.05;
      expect(inWall).toBe(false);
    }
  });

  it('a crowd spreads out around the player instead of stacking', () => {
    const { m, ai, run } = setup();
    for (let i = 0; i < 8; i++) m.spawn(Math.cos(i) * 10, Math.sin(i) * 10, 0);
    ai.alertAll(m.zombies);
    run(60 * 12);
    let minD = Infinity;
    for (const a of m.zombies) for (const b of m.zombies) if (a !== b) minD = Math.min(minD, Math.hypot(a.x - b.x, a.z - b.z));
    expect(minD).toBeGreaterThan(0.4);
    for (const zb of m.zombies) expect(Math.hypot(zb.x, zb.z)).toBeLessThan(3); // all close in on the player
  });

  it('attacks with a dodgeable wind-up and deals damage', () => {
    const { m, ai, run, all } = setup();
    m.spawn(0, -3, 0);
    ai.alertAll(m.zombies);
    run(60 * 3); // walk ~2 m (random 1.15–1.6 m/s) + 0.5 s wind-up
    const first = all.length;
    expect(first).toBeGreaterThan(0);
    expect(all[0].damage).toBeCloseTo(AI.damage);
  });

  it('dodging during the wind-up avoids the hit', () => {
    const { m, ai, target, run, all } = setup();
    const z = m.spawn(0, -0.9, 0);
    ai.alertAll(m.zombies);
    run(10); // starts winding up
    expect((z.brain as { mode: string }).mode).toBe('attack');
    target.x = 3; // step away
    run(60);
    expect(all.length).toBe(0);
  });

  it('loses a leg → crawls on toward the player', () => {
    const { m, ai, target, run } = setup();
    target.z = 6;
    const z = m.spawn(0, -2, 0);
    ai.alertAll(m.zombies);
    run(10);
    m.hit(z.parts[PART_INDEX.shinL].collider, 60, 0, 0, 2, 0, 0.3, -2, SIM_DT);
    expect(z.crawler).toBe(true);
    expect(z.alive).toBe(true);
    run(60 * 5); // falls, then switches to crawling
    expect(z.state).toBe('alive');
    const d0 = Math.hypot(z.x - target.x, z.z - target.z);
    run(60 * 3);
    const d1 = Math.hypot(z.x - target.x, z.z - target.z);
    expect(d0 - d1).toBeGreaterThan(1); // ~0.55 m/s
    expect(z.parts[PART_INDEX.pelvis].body.translation().y).toBeLessThan(0.4); // on the ground
  });

  it('walks around a crate in its way, and does not drag it along', () => {
    const { p, m, ai, target, run } = setup();
    // A 1.2 m, ~21 kg crate directly between the zombie and the player.
    const body = p.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.6, -3));
    p.world.createCollider(RAPIER.ColliderDesc.cuboid(0.6, 0.6, 0.6).setDensity(12).setFriction(0.7).setCollisionGroups(groups(Group.PROP, ALL)), body);
    ai.props = [{ body, radius: 0.75 }];
    const z = m.spawn(0, -7, 0);
    ai.alertAll(m.zombies);
    run(60 * 12);
    const t = body.translation();
    expect(Math.hypot(t.x - 0, t.z + 3)).toBeLessThan(0.3); // crate barely moved
    expect(Math.hypot(z.x - target.x, z.z - target.z)).toBeLessThan(AI.attackRange + 0.3); // still reached the player
  });

  it('a zombie pressing straight into a crate (no way around) only shoves it slowly', () => {
    const { p, m, ai, target, run } = setup([[-1.6, -3, 0.5, 4], [1.6, -3, 0.5, 4]]); // corridor 2.2 m wide
    const body = p.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.6, -3));
    p.world.createCollider(RAPIER.ColliderDesc.cuboid(0.6, 0.6, 0.6).setDensity(12).setFriction(0.7).setCollisionGroups(groups(Group.PROP, ALL)), body);
    ai.props = [{ body, radius: 0.75 }];
    m.spawn(0, -6, 0);
    target.z = 2;
    ai.alertAll(m.zombies);
    run(60 * 5);
    const moved = Math.hypot(body.translation().x, body.translation().z + 3);
    expect(moved).toBeLessThan(1.5); // a walking zombie would have carried it ~6 m
  });

  it('performance: 30 chasing zombies stay inside the budget', () => {
    const { p, m, ai, target, run } = setup([[5, 0, 0.3, 4], [-5, 3, 3, 0.3]]);
    for (let i = 0; i < 30; i++) m.spawn(Math.cos(i * 0.7) * 14, Math.sin(i * 0.7) * 14, 0);
    ai.alertAll(m.zombies);
    run(30);
    const times: number[] = [];
    const n = 120;
    for (let i = 0; i < n; i++) {
      target.x = Math.sin(i / 30) * 3;
      const t0 = performance.now();
      run(1);
      times.push(performance.now() - t0);
    }
    void p;
    times.sort((a, b) => a - b);
    expect(times[n / 2]).toBeLessThan(8); // median AI + animation + physics per tick (noise-robust on CI)
  });
});
