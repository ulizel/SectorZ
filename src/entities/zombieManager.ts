import * as THREE from 'three';
import { Zombie } from './zombie';
import type { PhysicsWorld, RAPIER } from '../physics/physicsWorld';
import { HUMANOID } from '../rigs/humanoid';

export interface RagdollCaps {
  /** Ragdolls actively simulated (not frozen). Beyond this the oldest is frozen in place. */
  maxRagdolls: number;
  maxLooseLimbs: number;
  /** Frozen corpses kept around. */
  maxCorpses: number;
  corpseLife: number;
}

/** Contact force (N) above which a ragdoll part takes impact damage (slammed into walls etc). */
export const IMPACT_DAMAGE_FORCE = 4500;
export interface ImpactResult { x: number; y: number; z: number; force: number; severed: boolean; mass: number }

export interface Bleeder { body: RAPIER.RigidBody; local: THREE.Vector3; t: number }

export interface ZombieHitResult { zombie: Zombie; part: number; severed: number; killed: boolean }

/**
 * Owns all zombies: lookup from collider → part, bullet/explosion damage, and the budget:
 * at most N ragdolls / loose limbs simulated; the oldest corpses sink away first.
 */
export class ZombieManager {
  readonly zombies: Zombie[] = [];
  private readonly byCollider = new Map<number, { z: Zombie; part: number }>();
  /** Severed stumps that are still spurting (consumed by the renderer for blood). */
  readonly bleeders: Bleeder[] = [];
  /** Zombies removed this tick (so views can be disposed). */
  readonly removed: Zombie[] = [];
  readonly spawned: Zombie[] = [];
  /** Zombies that died since the last update (each reported exactly once: kills, loot). */
  readonly newlyDead: Zombie[] = [];

  constructor(private readonly physics: PhysicsWorld, readonly caps: RagdollCaps) {}

  spawn(x: number, z: number, yaw: number): Zombie {
    const zb = new Zombie(this.physics, x, z, yaw);
    zb.parts.forEach((p, i) => this.byCollider.set(p.collider.handle, { z: zb, part: i }));
    this.zombies.push(zb);
    this.spawned.push(zb);
    return zb;
  }

  lookup(collider: RAPIER.Collider) { return this.byCollider.get(collider.handle); }

  update(dt: number): void {
    this.newlyDead.length = 0;
    for (const z of this.zombies) {
      if (!z.alive && !z.counted) { z.counted = true; this.newlyDead.push(z); }
      z.update(dt);
      // Freeze settled corpses; anything still twitching after 6 s is frozen anyway.
      if (z.state === 'dead' && !z.frozen && (z.restTime > 0.8 || z.deadTime > 6)) z.freeze();
    }
    for (let i = this.bleeders.length - 1; i >= 0; i--) {
      this.bleeders[i].t -= dt;
      if (this.bleeders[i].t <= 0) this.bleeders.splice(i, 1);
    }
    this.enforceBudget();
  }

  /** Bullet hit on a zombie collider. */
  hit(collider: RAPIER.Collider, damage: number, ix: number, iy: number, iz: number, px: number, py: number, pz: number, dt: number, limbMult = 1, flinch = 1): ZombieHitResult | null {
    const ref = this.byCollider.get(collider.handle);
    if (!ref) return null;
    const wasAlive = ref.z.alive;
    const severed = ref.z.hit(ref.part, damage, ix, iy, iz, px, py, pz, dt, true, limbMult, flinch);
    if (severed >= 0) this.addBleeders(ref.z, severed);
    return { zombie: ref.z, part: ref.part, severed, killed: wasAlive && !ref.z.alive };
  }

  /** Radial blast: damages, kills, tears limbs, and throws everything. Returns severed count. */
  explode(x: number, y: number, z: number, radius: number, damage: number, impulse: number, dt: number): number {
    let severedCount = 0;
    for (const zb of this.zombies) {
      const c = zb.parts[1].body.translation();
      const d = Math.hypot(c.x - x, c.z - z);
      if (d > radius + 1) continue;
      // Damage the whole zombie once, then tear/throw per part.
      const f0 = Math.max(0, 1 - d / radius);
      if (zb.frozen) zb.unfreeze();
      if (zb.alive) {
        zb.hp -= damage * f0;
        if (zb.hp <= 0) zb.kill(dt);
        else if (f0 > 0.15) zb.knockDown(dt); // survivors are blown off their feet and get back up
      }
      for (const p of zb.parts) {
        const t = p.body.translation();
        let dx = t.x - x, dy = t.y - y, dz = t.z - z;
        const dist = Math.max(0.3, Math.hypot(dx, dy, dz));
        if (dist > radius) continue;
        const f = 1 - dist / radius;
        dx /= dist; dy /= dist; dz /= dist;
        // Mostly outward + strong upward lift; light parts fly further (impulse ∝ mass^0.5).
        const k = impulse * f * Math.sqrt(p.def.mass / 5) * (0.8 + Math.random() * 0.4);
        const before = p.severed;
        const sev = zb.hit(p.index, damage * f * 0.35 * (0.4 + Math.random() * 1.2), dx * k, (dy * 0.5 + 0.9) * k, dz * k, t.x, t.y, t.z, dt);
        if (sev >= 0 && !before) { severedCount++; this.addBleeders(zb, sev); }
        if (p.dynamic) p.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * k * 0.05, y: (Math.random() - 0.5) * k * 0.05, z: (Math.random() - 0.5) * k * 0.05 }, true);
      }
    }
    return severedCount;
  }

  /**
   * Environmental impacts from the last physics step: ragdoll parts slammed into the world take
   * damage (and can tear off). Returns impacts for sound/FX.
   */
  processImpacts(contacts: { c1: number; c2: number; force: number }[], dt: number, out: ImpactResult[]): void {
    out.length = 0;
    for (const c of contacts) {
      for (const [mine, other] of [[c.c1, c.c2], [c.c2, c.c1]]) {
        const ref = this.byCollider.get(mine);
        if (!ref) continue;
        const o = this.byCollider.get(other);
        if (o && o.z === ref.z) continue; // self-contact
        const part = ref.z.parts[ref.part];
        if (!part.dynamic) continue;
        const t = part.body.translation();
        let severed = false;
        if (c.force > IMPACT_DAMAGE_FORCE) {
          const dmg = (c.force - IMPACT_DAMAGE_FORCE) / 200;
          const sev = ref.z.hit(ref.part, dmg, 0, 0, 0, t.x, t.y, t.z, dt);
          if (sev >= 0) { severed = true; this.addBleeders(ref.z, sev); }
        }
        out.push({ x: t.x, y: t.y, z: t.z, force: c.force, severed, mass: part.def.mass });
      }
    }
  }

  private addBleeders(z: Zombie, severed: number): void {
    const child = z.parts[severed];
    const parent = z.parts[child.parent];
    const d = child.def, pd = parent.def;
    // Both sides of the wound spurt: the flying limb and the stump on the body.
    this.bleeders.push({ body: child.body, local: new THREE.Vector3(-d.center[0], -d.center[1], -d.center[2]), t: 1.2 });
    this.bleeders.push({ body: parent.body, local: new THREE.Vector3(d.joint[0] - pd.center[0], d.joint[1] - pd.center[1], d.joint[2] - pd.center[2]), t: 1.6 });
  }

  /**
   * Budget: active (unfrozen) ragdolls beyond the cap are frozen in place (oldest first);
   * frozen corpses beyond their cap, too many loose limbs, or old corpses are removed (views sink them).
   */
  private enforceBudget(): void {
    const dead = this.zombies.filter((z) => !z.alive).sort((a, b) => b.deadTime - a.deadTime);
    const active = dead.filter((z) => !z.frozen);
    for (let i = 0; i < active.length - this.caps.maxRagdolls; i++) active[i].freeze();
    let looseLimbs = 0;
    for (const z of this.zombies) for (const p of z.parts) if (p.severed) looseLimbs++;
    let i = 0;
    while (i < dead.length && (dead.length - i > this.caps.maxCorpses || looseLimbs > this.caps.maxLooseLimbs || dead[i].deadTime > this.caps.corpseLife)) {
      const z = dead[i++];
      for (const p of z.parts) if (p.severed) looseLimbs--;
      this.remove(z);
    }
  }

  remove(z: Zombie): void {
    const idx = this.zombies.indexOf(z);
    if (idx < 0) return;
    this.zombies.splice(idx, 1);
    for (const p of z.parts) this.byCollider.delete(p.collider.handle);
    for (let i = this.bleeders.length - 1; i >= 0; i--) if (z.parts.some((p) => p.body === this.bleeders[i].body)) this.bleeders.splice(i, 1);
    z.destroy();
    this.removed.push(z);
  }

  clear(): void { for (const z of [...this.zombies]) this.remove(z); }

  get aliveCount(): number { return this.zombies.filter((z) => z.alive).length; }
  get ragdollCount(): number { return this.zombies.filter((z) => z.ragdoll && !z.frozen).length; }
  get frozenCount(): number { return this.zombies.filter((z) => z.frozen).length; }
  get deadCount(): number { return this.zombies.filter((z) => !z.alive).length; }
  get severedCount(): number { let n = 0; for (const z of this.zombies) for (const p of z.parts) if (p.severed) n++; return n; }
}

void HUMANOID;
