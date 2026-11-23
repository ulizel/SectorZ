/**
 * Pure state machine for the right-hand (aim) stick. No DOM, so it is unit-tested directly.
 *
 *  - Quick tap (< TAP_MAX s, never left the deadzone) → one "tap shot" along the current aim.
 *  - Holding inside the deadzone, then lifting → nothing (cancel).
 *  - Drag past the deadzone → `aiming` (aim line visible, automatic weapons fire).
 *  - Drag back inside the deadzone → aiming cancelled (line hidden, firing stops).
 *  - Lift while aiming → one queued "release shot" along the last aimed direction
 *    (used by single-shot weapons). Lift while not aiming → nothing.
 */
export const AIM_DEADZONE = 0.3; // fraction of full stick deflection
const DEADZONE_EXIT = 0.24; // small hysteresis so the line doesn't flicker at the edge
/** Automatic weapons: push past this deflection to fire (inside it you only aim). */
export const FIRE_ZONE = 0.92;
const FIRE_ZONE_EXIT = 0.85;
/** A touch shorter than this (s) that never left the deadzone counts as a tap-to-fire. */
export const TAP_MAX = 0.25;

export class AimStickLogic {
  active = false;
  aiming = false;
  /** Pushed into the outer fire zone (automatic weapons fire while true). */
  firing = false;
  dirX = 0;
  dirY = 0;
  /** Deflection beyond the deadzone, 0..1 (light push = fine aim). */
  mag = 0;
  private release: { x: number; y: number } | null = null;
  private startTime = 0;
  private everAimed = false;
  private tapQueued = false;

  /** `now` in seconds (for tap detection). */
  start(now = 0): void {
    this.active = true;
    this.aiming = false;
    this.everAimed = false;
    this.startTime = now;
  }

  /** nx, ny: deflection normalised to the stick radius (screen space, +y down). */
  move(nx: number, ny: number): void {
    if (!this.active) return;
    const m = Math.hypot(nx, ny);
    const threshold = this.aiming ? DEADZONE_EXIT : AIM_DEADZONE;
    if (m >= threshold) {
      this.aiming = true;
      this.everAimed = true;
      this.dirX = nx / m;
      this.dirY = ny / m;
      this.mag = Math.min(1, (m - AIM_DEADZONE) / (1 - AIM_DEADZONE));
      this.firing = m >= (this.firing ? FIRE_ZONE_EXIT : FIRE_ZONE);
    } else {
      this.aiming = false;
      this.firing = false;
    }
  }

  end(now = 0): void {
    if (this.active && this.aiming) this.release = { x: this.dirX, y: this.dirY };
    else if (this.active && !this.everAimed && now - this.startTime < TAP_MAX) this.tapQueued = true;
    this.active = false;
    this.aiming = false;
    this.firing = false;
  }

  /** True once after a quick tap. */
  consumeTap(): boolean {
    const t = this.tapQueued;
    this.tapQueued = false;
    return t;
  }

  /** Returns the release-shot direction once, then clears it. */
  consumeRelease(): { x: number; y: number } | null {
    const r = this.release;
    this.release = null;
    return r;
  }
}
