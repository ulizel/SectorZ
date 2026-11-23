/**
 * Pure state machine for the right-hand (aim) stick. No DOM, so it is unit-tested directly.
 *
 *  - Drag past the deadzone → aim only (aim line visible, nothing fires).
 *  - Quick tap (< TAP_MAX s, never dragged) → one shot along the current aim.
 *  - Touch and hold still for HOLD_TIME → fire (single shot for the pistol, continuous for
 *    automatic weapons) until the thumb lifts; dragging while holding aims slowly.
 */
export const AIM_DEADZONE = 0.3; // fraction of full stick deflection
const DEADZONE_EXIT = 0.24; // small hysteresis so the line doesn't flicker at the edge
/** A touch shorter than this (s) that never left the deadzone is a tap-to-fire. */
export const TAP_MAX = 0.25;
/** Holding still this long (s) starts firing. */
export const HOLD_TIME = 0.2;

export class AimStickLogic {
  active = false;
  /** Thumb is past the deadzone (aim target valid). */
  aiming = false;
  /** Touch-and-hold fire is on. */
  firing = false;
  dirX = 0;
  dirY = 0;
  /** Deflection beyond the deadzone, 0..1 (light push = fine aim). */
  mag = 0;
  private startTime = 0;
  private everAimed = false;
  private tapQueued = false;
  private holdQueued = false;

  /** `now` in seconds. */
  start(now = 0): void {
    this.active = true;
    this.aiming = this.firing = this.everAimed = false;
    this.startTime = now;
  }

  /** nx, ny: deflection normalised to the stick radius (screen space, +y down). */
  move(nx: number, ny: number): void {
    if (!this.active) return;
    const m = Math.hypot(nx, ny);
    if (m >= (this.aiming ? DEADZONE_EXIT : AIM_DEADZONE)) {
      this.aiming = true;
      if (!this.firing) this.everAimed = true; // a drag before the hold kicks in = aim only
      this.dirX = nx / m;
      this.dirY = ny / m;
      this.mag = Math.min(1, (m - AIM_DEADZONE) / (1 - AIM_DEADZONE));
    } else {
      this.aiming = false;
    }
  }

  /** Call every tick while active: turns a still hold into firing. */
  update(now: number): void {
    if (this.active && !this.firing && !this.everAimed && now - this.startTime >= HOLD_TIME) {
      this.firing = true;
      this.holdQueued = true;
    }
  }

  end(now = 0): void {
    if (this.active && !this.everAimed && !this.firing && now - this.startTime < TAP_MAX) this.tapQueued = true;
    this.active = this.aiming = this.firing = false;
  }

  /** True once after a quick tap. */
  consumeTap(): boolean { const t = this.tapQueued; this.tapQueued = false; return t; }
  /** True once when hold-fire starts (the single-shot weapons' shot). */
  consumeHoldStart(): boolean { const t = this.holdQueued; this.holdQueued = false; return t; }
}
