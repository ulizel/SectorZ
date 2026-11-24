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
/** Steady-aim bonus: hold still for this long (s) to reach minimum spread. */
export const STEADY_TIME = 0.5;
/** Spread multiplier at full steadiness. */
export const STEADY_BONUS = 0.45;
/** Stance: movement bloom at full running speed (walking slowly costs proportionally less). */
export const MOVE_BLOOM = 2.2;
/** Vertical recoil decay (1/s) and cap (rad): quick follow-up pistol shots climb toward the head. */
export const PITCH_DECAY = 2.5;
export const MAX_PITCH = 0.1;

export class AimModel {
  angle = 0; // radians, atan2(x, z)
  bloom = 0; // extra spread multiplier: spread = def.spread * (1 + bloom)
  angularVel = 0;
  /** Vertical recoil (rad, + = up) added to the next shot's pitch; decays back to 0. */
  pitch = 0;
  /** 0..1: how settled the aim is (held still, not moving, not just fired). */
  steady = 0;

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
    // Stance: standing is accurate, walking widens, running is worst (quadratic: slow walk is cheap).
    const target = Math.min(MAX_BLOOM, this.angularVel * 0.35 + moveFrac * moveFrac * MOVE_BLOOM);
    const rate = target > this.bloom ? 10 : def.settle; // blooms fast, settles at weapon rate
    this.pitch *= Math.exp(-PITCH_DECAY * dt);
    this.bloom += (target - this.bloom) * (1 - Math.exp(-rate * dt));
    // Steady-aim: build up while still and settled, lose it instantly on movement/turning.
    const still = this.angularVel < 0.08 && moveFrac < 0.05 && this.bloom < 0.25;
    this.steady = still ? Math.min(1, this.steady + dt / STEADY_TIME) : 0;
  }

  /** `burstIndex`: 1-based shot number in the current burst (selects the recoil-pattern step). */
  onShot(def: WeaponDef, burstIndex = 1, rand: () => number = Math.random): void {
    this.bloom = Math.min(MAX_BLOOM, this.bloom + def.recoilBloom);
    this.steady = 0;
    this.pitch = Math.min(MAX_PITCH, this.pitch + (def.pitchKick ?? 0));
    const pat = def.recoilPattern;
    const kick = pat[(burstIndex - 1) % pat.length] + (rand() * 2 - 1) * def.aimKick;
    this.angle += kick; // learnable pattern + a little noise; the stick pulls it back
  }

  spread(def: WeaponDef): number {
    const steadyMul = 1 - (1 - STEADY_BONUS) * this.steady;
    return def.spread * (1 + this.bloom) * steadyMul;
  }
}
