import { describe, it, expect, beforeAll } from 'vitest';
import { initPhysics, PhysicsWorld, RAPIER, Group, groups, ALL } from '../src/physics/physicsWorld';
import { GRENADE, throwVelocity, spawnGrenade, stepGrenade, flightTime } from '../src/weapons/grenade';
import { SIM_DT } from '../src/config';

beforeAll(async () => { await initPhysics(); });

function groundWorld() {
  const p = new PhysicsWorld();
  p.world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0).setCollisionGroups(groups(Group.STATIC, ALL)));
  return p;
}

describe('grenades (headless Rapier)', () => {
  it.each([3, 8, 14])('a %i m throw first lands near the aimed point', (dist) => {
    const p = groundWorld();
    const g = spawnGrenade(p, 0, GRENADE.releaseHeight, 0, throwVelocity(0, dist, GRENADE.releaseHeight));
    let landed = null as null | { z: number; t: number };
    for (let i = 0; i < 240 && !landed; i++) {
      const vy = g.body.linvel().y;
      p.step();
      if (vy < 0 && g.body.linvel().y > vy + 1) landed = { z: g.body.translation().z, t: (i + 1) * SIM_DT };
    }
    expect(landed).not.toBeNull();
    expect(Math.abs(landed!.z - dist)).toBeLessThan(0.6);
    expect(Math.abs(landed!.t - flightTime(dist))).toBeLessThan(0.1);
    p.free();
  });

  it('bounces off a wall instead of passing through it (CCD), then settles', () => {
    const p = groundWorld();
    p.world.createCollider(RAPIER.ColliderDesc.cuboid(5, 1.5, 0.1).setTranslation(0, 1.5, 4).setCollisionGroups(groups(Group.STATIC, ALL)));
    const g = spawnGrenade(p, 0, 1.0, 0, { x: 0, y: 1, z: 30 }); // very fast, straight at a thin wall
    let bounced = false;
    for (let i = 0; i < 110; i++) {
      p.step();
      expect(g.body.translation().z).toBeLessThan(4);
      if (stepGrenade(g, SIM_DT) === 'bounce') bounced = true;
    }
    expect(bounced).toBe(true);
    expect(g.body.linvel().z).toBeLessThanOrEqual(0.5); // came back off the wall
    const v = g.body.linvel();
    expect(Math.hypot(v.x, v.z)).toBeLessThan(0.5); // skidded to a stop before the fuse
    p.free();
  });

  it('the fuse goes off after GRENADE.fuse seconds', () => {
    const p = groundWorld();
    const g = spawnGrenade(p, 0, 0.5, 0, { x: 0, y: 0, z: 0 });
    let ticks = 0, r: string | null = null;
    while (r !== 'boom' && ticks < 600) { p.step(); r = stepGrenade(g, SIM_DT); ticks++; }
    expect(r).toBe('boom');
    expect(Math.abs(ticks * SIM_DT - GRENADE.fuse)).toBeLessThan(2 * SIM_DT);
    p.free();
  });
});
