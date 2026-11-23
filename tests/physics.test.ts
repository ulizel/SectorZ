import { describe, it, expect, beforeAll } from 'vitest';
import { initPhysics, PhysicsWorld, RAPIER, Group, groups, ALL } from '../src/physics/physicsWorld';
import { Player } from '../src/entities/player';
import { emptyCommand } from '../src/input/commands';
import { SIM_DT, PROPS } from '../src/config';
import { WEAPONS } from '../src/weapons/weapon';

beforeAll(async () => { await initPhysics(); });

function groundWorld() {
  const p = new PhysicsWorld();
  p.world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0).setCollisionGroups(groups(Group.STATIC, ALL)));
  return p;
}

describe('hitscan + impulses (headless Rapier)', () => {
  it('a raycast hits a crate at the right point and the impulse pushes it away', () => {
    const p = groundWorld();
    const body = p.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.6, 5));
    p.world.createCollider(RAPIER.ColliderDesc.cuboid(0.6, 0.6, 0.6).setDensity(PROPS.crateDensity).setCollisionGroups(groups(Group.PROP, ALL)), body);
    for (let i = 0; i < 30; i++) p.step(); // settle
    const hit = p.raycast(0, 1.1, 0, 0, 0, 1, 40, groups(Group.PLAYER, ALL & ~Group.PLAYER));
    expect(hit).not.toBeNull();
    expect(hit!.point.z).toBeCloseTo(4.4, 1);
    expect(hit!.normal.z).toBeCloseTo(-1, 2);
    expect(hit!.collider.parent()!.handle).toBe(body.handle);
    const imp = WEAPONS.pistol.impulse;
    body.applyImpulseAtPoint({ x: 0, y: imp * 0.15, z: imp }, hit!.point, true);
    expect(body.linvel().z).toBeGreaterThan(0.3); // shoved away from the shooter
    expect(body.angvel().x).toBeGreaterThan(0); // hit above centre → tips backwards
    p.free();
  });

  it('three pistol shots knock over a barrel (combat feel)', () => {
    const p = groundWorld();
    const b = p.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.6, 5).setLinearDamping(0.2).setAngularDamping(0.5));
    p.world.createCollider(RAPIER.ColliderDesc.cylinder(0.6, 0.36).setDensity(PROPS.barrelDensity).setFriction(0.6), b);
    for (let i = 0; i < 30; i++) p.step();
    const imp = WEAPONS.pistol.impulse;
    for (let s = 0; s < 3; s++) {
      b.applyImpulseAtPoint({ x: 0, y: imp * 0.15, z: imp }, { x: 0, y: 1.1, z: 4.64 }, true);
      for (let i = 0; i < 12; i++) p.step(); // 0.2 s fire interval
    }
    for (let i = 0; i < 90; i++) p.step();
    const r = b.rotation();
    const upY = 1 - 2 * (r.x * r.x + r.z * r.z); // barrel's local up · world up
    expect(upY).toBeLessThan(0.5); // lying on its side
    expect(b.translation().y).toBeGreaterThan(0.2); // and not through the floor
    p.free();
  });

  it('the ray ignores the shooter collider when excluded', () => {
    const p = groundWorld();
    const pl = new Player(1, p, 0, 0);
    const hit = p.raycast(0, 1.1, 0, 0, 0, 1, 10, groups(Group.PLAYER, ALL & ~Group.PLAYER), pl.collider);
    expect(hit).toBeNull();
    p.free();
  });
});

describe('Player controller', () => {
  it('moves at roughly moveSpeed and is blocked by walls', () => {
    const p = groundWorld();
    p.world.createCollider(RAPIER.ColliderDesc.cuboid(5, 1, 0.5).setTranslation(0, 1, 4).setCollisionGroups(groups(Group.STATIC, ALL)));
    const pl = new Player(1, p, 0, 0);
    const cmd = emptyCommand();
    cmd.moveZ = 1;
    for (let i = 0; i < 120; i++) { pl.update(cmd, SIM_DT); p.step(); }
    // Wall face at z=3.5, capsule radius 0.32 → must stop before ~3.2
    expect(pl.z).toBeGreaterThan(2.9);
    expect(pl.z).toBeLessThan(3.25);
    // Free movement sideways
    cmd.moveZ = 0; cmd.moveX = 1;
    const x0 = pl.x;
    for (let i = 0; i < 60; i++) { pl.update(cmd, SIM_DT); p.step(); }
    expect(pl.x - x0).toBeGreaterThan(4);
    expect(pl.x - x0).toBeLessThan(5.5);
    p.free();
  });
});
