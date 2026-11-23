/**
 * World-space intent for one player for one sim tick. This is the only thing the
 * simulation reads from input, so a remote co-op player can be driven by the same struct.
 */
export interface InputCommand {
  moveX: number; // -1..1 world X
  moveZ: number; // -1..1 world Z
  aimX: number; // normalised world-space aim direction (0,0 = keep current)
  aimZ: number;
  /** Player is deliberately aiming (touch: aim stick past deadzone; mouse: always). */
  aiming: boolean;
  /** Trigger held this tick (automatic weapons fire while true). */
  trigger: boolean;
  /** One-shot trigger pull this tick (single-shot weapons fire on this). */
  triggerTap: boolean;
  reload: boolean;
  /** Weapon slot to switch to, or -1 for "next", or null for no change. */
  switchWeapon: number | null;
}

export const emptyCommand = (): InputCommand => ({
  moveX: 0, moveZ: 0, aimX: 0, aimZ: 0, aiming: false, trigger: false, triggerTap: false, reload: false, switchWeapon: null,
});

/** Raw, device-level state. Resolved into an InputCommand by the game (needs camera + weapon type). */
export interface RawInput {
  moveX: number; // screen-space: +x right, +y down
  moveY: number;
  /** Mouse aim as a screen pixel position. */
  aimScreen: { x: number; y: number } | null;
  /** Mouse button held / pressed this tick (edge). */
  mouseHeld: boolean;
  mousePressed: boolean;
  /** Touch aim stick direction (screen space) while dragged past the deadzone. */
  aimStick: { x: number; y: number } | null;
  /** Touch aim stick deflection beyond the deadzone, 0..1. */
  aimStickMag: number;
  /** A touch is down on the aim side (aim line visible). */
  stickActive: boolean;
  /** Touch-and-hold fire is on. */
  stickFiring: boolean;
  /** One-shot trigger this tick (quick tap, or the start of a hold). */
  stickTap: boolean;
  reload: boolean;
  switchWeapon: number | null;
}

export const emptyRaw = (): RawInput => ({
  moveX: 0, moveY: 0, aimScreen: null, mouseHeld: false, mousePressed: false,
  aimStick: null, aimStickMag: 0, stickActive: false, stickFiring: false, stickTap: false, reload: false, switchWeapon: null,
});
