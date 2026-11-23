/**
 * World-space intent for one player for one sim tick. This is the only thing the
 * simulation reads from input, so a remote co-op player can be driven by the same struct.
 */
export interface InputCommand {
  moveX: number; // -1..1 world X
  moveZ: number; // -1..1 world Z
  aimX: number; // normalised world-space aim direction (0,0 = keep current)
  aimZ: number;
  fire: boolean;
  reload: boolean;
}

export const emptyCommand = (): InputCommand => ({ moveX: 0, moveZ: 0, aimX: 0, aimZ: 0, fire: false, reload: false });

/** Raw, device-level state. Resolved into an InputCommand by the game (needs camera for mouse aim). */
export interface RawInput {
  moveX: number; // screen-space: +x right, +y down
  moveY: number;
  /** Aim as a screen pixel position (mouse) … */
  aimScreen: { x: number; y: number } | null;
  /** … or as a stick direction (touch / gamepad), screen-space. */
  aimStick: { x: number; y: number } | null;
  fire: boolean;
  reload: boolean;
}
