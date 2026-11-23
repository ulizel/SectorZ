import { angleDelta } from '../core/math';
import type { WeaponDef } from './weapon';

/**
 * Simulation-style aim: the aim direction has inertia and accuracy "blooms" with motion.
 *  - Turn speed is proportional to the remaining angle (fast flick, gentle settle),
 *    scaled by stick deflection (light push = fine aim) and the weapon's handling.
 *  - Bloom grows with aim turning, player movement and recoil; it settles when steady.
 * Pure logic (no DOM/three) so it runs on a co-op host and in unit tests.
 */
export const AIM_GAIN = 8; // 1/s: turn rate per radian of remaining error
export const AIM_MIN_RATE = 0.6; // rad/s floor so the last degrees still arrive
export const MAX_BLOOM = 4;

export class AimModel {
  angle = 0; // radians, atan2(x, z)
  bloom = 0; // extra spread multiplier: spread = def.spread * (1 + bloom)
  angularVel = 0;

  get x(): number { return Math.sin(this.angle); }
  get z(): number { return Math.cos(this.angle); }

  /** Snap (mouse aim is direct). */
  set(angle: number, dt: number): void {
    this.angularVel = Math.abs(angleDelta(this.angle, angle)) / dt;
    this.angle = angle;
  }

  /** Turn toward `target` with inertia. `deflection` 0..1 beyond the stick deadzone. */
  turnToward(target: number, deflection: number, def: WeaponDef, dt: number): void {
    const d = angleDelta(this.angle, target);
    const handling = 0.3 + 0.7 * Math.min(1, Math.max(0, deflection));
    const rate = Math.min(def.aimTurn, Math.max(AIM_MIN_RATE, Math.abs(d) * AIM_GAIN)) * handling;
    const step = Math.sign(d) * Math.min(Math.abs(d), rate * dt);
    this.angle += step;
    this.angularVel = Math.abs(step) / dt;
  }

  /** Remaining error to a target, radians. */
  errorTo(target: number): number { return Math.abs(angleDelta(this.angle, target)); }

  hold(dt: number): void { this.angularVel = 0; void dt; }

  /** Update bloom from aim motion and movement (0..1 of top speed). */
  updateBloom(def: WeaponDef, moveFrac: number, dt: number): void {
    const target = Math.min(MAX_BLOOM, this.angularVel * 0.35 + moveFrac * 1.2);
    const rate = target > this.bloom ? 10 : def.settle; // blooms fast, settles at weapon rate
    this.bloom += (target - this.bloom) * (1 - Math.exp(-rate * dt));
  }

  onShot(def: WeaponDef): void { this.bloom = Math.min(MAX_BLOOM, this.bloom + def.recoilBloom); }

  spread(def: WeaponDef): number { return def.spread * (1 + this.bloom); }
}
