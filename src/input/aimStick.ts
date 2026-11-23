/**
 * Pure state machine for the right-hand (aim) stick. No DOM, so it is unit-tested directly.
 *
 *  - Touch down: nothing happens yet (taps are ignored).
 *  - Drag past the deadzone → `aiming` (aim line visible, automatic weapons fire).
 *  - Drag back inside the deadzone → aiming cancelled (line hidden, firing stops).
 *  - Lift while aiming → one queued "release shot" along the last aimed direction
 *    (used by single-shot weapons). Lift while not aiming → nothing.
 */
export const AIM_DEADZONE = 0.3; // fraction of full stick deflection
const DEADZONE_EXIT = 0.24; // small hysteresis so the line doesn't flicker at the edge
/** Automatic weapons: push past this deflection to fire (inside it you only aim). */
export const FIRE_ZONE = 0.75;
const FIRE_ZONE_EXIT = 0.68;

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

  start(): void {
    this.active = true;
    this.aiming = false;
  }

  /** nx, ny: deflection normalised to the stick radius (screen space, +y down). */
  move(nx: number, ny: number): void {
    if (!this.active) return;
    const m = Math.hypot(nx, ny);
    const threshold = this.aiming ? DEADZONE_EXIT : AIM_DEADZONE;
    if (m >= threshold) {
      this.aiming = true;
      this.dirX = nx / m;
      this.dirY = ny / m;
      this.mag = Math.min(1, (m - AIM_DEADZONE) / (1 - AIM_DEADZONE));
      this.firing = m >= (this.firing ? FIRE_ZONE_EXIT : FIRE_ZONE);
    } else {
      this.aiming = false;
      this.firing = false;
    }
  }

  end(): void {
    if (this.active && this.aiming) this.release = { x: this.dirX, y: this.dirY };
    this.active = false;
    this.aiming = false;
    this.firing = false;
  }

  /** Returns the release-shot direction once, then clears it. */
  consumeRelease(): { x: number; y: number } | null {
    const r = this.release;
    this.release = null;
    return r;
  }
}
