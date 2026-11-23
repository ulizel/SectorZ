import RAPIER from '@dimforge/rapier3d-compat';
import { SIM_DT } from '../config';

export { RAPIER };

let initPromise: Promise<void> | null = null;
/** Rapier's WASM must be initialised once before any world is created. */
export function initPhysics(): Promise<void> {
  return (initPromise ??= RAPIER.init());
}

/**
 * Collision groups (Rapier packs membership in the high 16 bits, filter in the low 16).
 * Keeping these central is what will let ragdolls, limbs and bullets ignore what they should.
 */
export const Group = {
  STATIC: 1 << 0,
  PLAYER: 1 << 1,
  ZOMBIE: 1 << 2,
  RAGDOLL: 1 << 3,
  DEBRIS: 1 << 4,
  PROP: 1 << 5,
} as const;
export const ALL = 0xffff;
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

export interface RayHit {
  collider: RAPIER.Collider;
  toi: number;
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}

export class PhysicsWorld {
  readonly world: RAPIER.World;
  lastStepMs = 0;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = SIM_DT;
  }

  step(): void {
    const t0 = performance.now();
    this.world.step();
    this.lastStepMs = performance.now() - t0;
  }

  /** Hitscan ray. `filterGroups` uses the same packing as collider groups (who the ray "is" and what it hits). */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number,
    filterGroups: number, exclude?: RAPIER.Collider): RayHit | null {
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, filterGroups, exclude);
    if (!hit) return null;
    const p = ray.pointAt(hit.timeOfImpact);
    return {
      collider: hit.collider,
      toi: hit.timeOfImpact,
      point: { x: p.x, y: p.y, z: p.z },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
    };
  }

  get bodyCount(): number { return this.world.bodies.len(); }
  get colliderCount(): number { return this.world.colliders.len(); }

  free(): void { this.world.free(); }
}
