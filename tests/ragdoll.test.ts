import { describe, it, expect, beforeAll } from 'vitest';
import { initPhysics, PhysicsWorld, RAPIER, Group, groups, ALL } from '../src/physics/physicsWorld';
import { Zombie } from '../src/entities/zombie';
import { HUMANOID, PART_INDEX } from '../src/rigs/humanoid';
import { SIM_DT } from '../src/config';

beforeAll(async () => { await initPhysics(); });

function world() {
  const p = new PhysicsWorld();
  p.world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0).setCollisionGroups(groups(Group.STATIC, ALL)));
  return p;
}
const run = (p: PhysicsWorld, zs: Zombie[], steps: number) => { for (let i = 0; i < steps; i++) { zs.forEach((z) => z.update(SIM_DT)); p.step(); } };

/** World-space distance between the two anchors of part i's joint (0 = joint holding). */
function jointGap(z: Zombie, i: number): number {
  const c = z.parts[i], par = z.parts[c.parent];
  const toWorld = (b: RAPIER.RigidBody, l: { x: number; y: number; z: number }) => {
    const r = b.rotation(), t = b.translation();
    const qx = r.x, qy = r.y, qz = r.z, qw = r.w;
    const ix = qw * l.x + qy * l.z - qz * l.y, iy = qw * l.y + qz * l.x - qx * l.z, iz = qw * l.z + qx * l.y - qy * l.x, iw = -qx * l.x - qy * l.y - qz * l.z;
    return { x: t.x + ix * qw + iw * -qx + iy * -qz - iz * -qy, y: t.y + iy * qw + iw * -qy + iz * -qx - ix * -qz, z: t.z + iz * qw + iw * -qz + ix * -qy - iy * -qx };
  };
  const d = c.def, pd = par.def;
  const a = toWorld(par.body, { x: d.joint[0] - pd.center[0], y: d.joint[1] - pd.center[1], z: d.joint[2] - pd.center[2] });
  const b = toWorld(c.body, { x: -d.center[0], y: -d.center[1], z: -d.center[2] });
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('Zombie ragdoll (headless Rapier)', () => {
  it('alive: parts follow the animation and stand on the floor', () => {
    const p = world();
    const z = new Zombie(p, 0, 0, 0);
    run(p, [z], 60);
    const head = z.parts[PART_INDEX.head].body.translation();
    expect(head.y).toBeGreaterThan(1.3);
    for (const part of z.parts) expect(part.body.isKinematic()).toBe(true);
  });

  it('dies into a stable articulated ragdoll: falls, joints hold, nothing explodes or sinks', () => {
    const p = world();
    const z = new Zombie(p, 0, 0, 0);
    run(p, [z], 10);
    z.hit(PART_INDEX.head, 200, 0, 2, 12, 0, 1.55, 0.1, SIM_DT); // lethal head shot pushing it backwards
    expect(z.alive).toBe(false);
    run(p, [z], 240); // 4 s
    for (const part of z.parts) {
      const t = part.body.translation();
      expect(Number.isFinite(t.x + t.y + t.z)).toBe(true);
      expect(t.y).toBeGreaterThan(0.02); // nothing through the floor
      expect(t.y).toBeLessThan(0.8); // it fell down
    }
    for (const part of z.parts) {
      if (part.parent < 0 || part.severed) continue;
      expect(jointGap(z, part.index)).toBeLessThan(0.03); // articulation holds (< 3 cm)
    }
  });

  it('limb damage tears the arm off: separate body that keeps flying, zombie stays alive', () => {
    const p = world();
    const z = new Zombie(p, 0, 0, 0);
    run(p, [z], 10);
    const fa = PART_INDEX.forearmL;
    let severed = -1;
    for (let s = 0; s < 3 && severed < 0; s++) severed = z.hit(fa, 25, 6, 1, 0, 0.3, 1.2, 0.4, SIM_DT);
    expect(severed).toBe(fa);
    expect(z.alive).toBe(true);
    expect(z.parts[fa].joint).toBeNull();
    expect(z.parts[fa].body.isDynamic()).toBe(true);
    run(p, [z], 30);
    const ua = z.parts[PART_INDEX.upperArmL].body.translation();
    const f = z.parts[fa].body.translation();
    expect(Math.hypot(f.x - ua.x, f.y - ua.y, f.z - ua.z)).toBeGreaterThan(0.5); // flew away
    run(p, [z], 180);
    expect(z.parts[fa].body.translation().y).toBeGreaterThan(0.02); // landed on, not through, the floor
  });

  it('a big explosion impulse rips the head off and kills', () => {
    const p = world();
    const z = new Zombie(p, 0, 0, 0);
    run(p, [z], 5);
    const sev = z.hit(PART_INDEX.head, 10, 0, 30, 30, 0, 1.6, 0, SIM_DT);
    expect(sev).toBe(PART_INDEX.head);
    expect(z.alive).toBe(false);
  });

  it('performance: 12 ragdolls + limbs step well inside budget', () => {
    const p = world();
    const zs = Array.from({ length: 12 }, (_, i) => new Zombie(p, (i % 4) * 2 - 3, Math.floor(i / 4) * 2, 0));
    run(p, zs, 5);
    zs.forEach((z, i) => { z.hit(PART_INDEX.forearmR, 50, 5, 2, 0, 0, 1, 0, SIM_DT); z.hit(PART_INDEX.torso, 200, i % 2 ? 20 : -20, 10, 5, 0, 1.2, 0, SIM_DT); });
    const times: number[] = [];
    for (let s = 0; s < 120; s++) { zs.forEach((z) => z.update(SIM_DT)); p.step(); times.push(p.lastStepMs); }
    // Median ignores one-off hiccups on shared CI machines; typical here is ~2-3 ms.
    times.sort((a, b) => a - b);
    expect(times[60]).toBeLessThan(6);
    void HUMANOID;
  });
});
