import { Group, groups, ALL, RAPIER, type PhysicsWorld } from '../physics/physicsWorld';

/** Frag grenade tunables. */
export const GRENADE = {
  fuse: 2, // s from release
  radius: 5, // blast radius (m), same as a barrel
  minRange: 3, // m (light stick push)
  maxRange: 14, // m (full push)
  start: 3, // carried at the start of a run
  max: 5,
  half: 0.09, // half-size of the voxel grenade body (m)
  releaseHeight: 1.4, // hand height at release
  restitution: 0.35,
  friction: 0.8,
};

/** Flight time for a throw of `dist` metres: short throws are flat, long ones lob. */
export const flightTime = (dist: number) => 0.55 + dist * 0.045;

/**
 * Launch velocity that lands (first touch) at horizontal offset (dx, dz) from the release point,
 * released at height `y0`, landing at the grenade's resting height.
 */
export function throwVelocity(dx: number, dz: number, y0: number, g = 9.81): { x: number; y: number; z: number } {
  const dist = Math.hypot(dx, dz), t = flightTime(dist);
  return { x: dx / t, y: (GRENADE.half - y0 + 0.5 * g * t * t) / t, z: dz / t };
}

export interface Grenade {
  body: RAPIER.RigidBody;
  fuse: number;
  /** Speed last tick (a sudden drop = a bounce, for the clink sound). */
  lastSpeed: number;
  landed: boolean;
}

/**
 * A small dynamic voxel box with CCD (never tunnels through walls). It bounces off the world, props
 * and ragdolls; it ignores the player (can't hit the thrower) and bullets pass by it. Living zombies
 * are kinematic (they'd bat it back like a wall), so they aren't colliders: see `hitZombie`.
 */
export function spawnGrenade(physics: PhysicsWorld, x: number, y: number, z: number, v: { x: number; y: number; z: number }): Grenade {
  const w = physics.world;
  const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z)
    .setLinvel(v.x, v.y, v.z).setAngvel({ x: v.z * 1.5, y: 0, z: -v.x * 1.5 }).setAngularDamping(1).setCcdEnabled(true));
  const h = GRENADE.half;
  w.createCollider(RAPIER.ColliderDesc.cuboid(h, h * 1.3, h).setDensity(800)
    .setRestitution(GRENADE.restitution).setFriction(GRENADE.friction)
    .setCollisionGroups(groups(Group.DEBRIS, ALL & ~Group.PLAYER & ~Group.ZOMBIE)), body);
  return { body, fuse: GRENADE.fuse, lastSpeed: Math.hypot(v.x, v.y, v.z), landed: false };
}

/** A grenade flying into a living zombie's body thuds against it and drops at its feet. */
export function hitZombie(g: Grenade, zx: number, zz: number): boolean {
  const t = g.body.translation();
  if (t.y > 1.8 || Math.hypot(t.x - zx, t.z - zz) > 0.45) return false;
  const v = g.body.linvel();
  if (Math.hypot(v.x, v.z) < 1.5) return false;
  g.body.setLinvel({ x: v.x * 0.15, y: Math.min(v.y, 0), z: v.z * 0.15 }, true);
  return true;
}

/** One tick of a live grenade. Returns 'boom' when the fuse runs out, 'bounce' on a hard bounce. */
export function stepGrenade(g: Grenade, dt: number): 'boom' | 'bounce' | null {
  g.fuse -= dt;
  if (g.fuse <= 0) return 'boom';
  const v = g.body.linvel(), s = Math.hypot(v.x, v.y, v.z);
  const bounced = g.lastSpeed - s > 1.5;
  g.lastSpeed = s;
  // Once it has touched down, let it skid to a stop instead of sliding forever.
  if (!g.landed && g.body.translation().y < GRENADE.half * 3) { g.landed = true; g.body.setLinearDamping(1.2); }
  return bounced ? 'bounce' : null;
}
