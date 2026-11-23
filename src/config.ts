/** Central tunables. Gameplay feel lives here so it can be tweaked without hunting through code. */
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;
export const MAX_STEPS_PER_FRAME = 4;

export const PLAYER = {
  moveSpeed: 5.2, // m/s
  accel: 40, // m/s² toward target velocity
  decel: 32,
  turnSpeed: 26, // rad/s body yaw toward aim
  radius: 0.32,
  halfHeight: 0.55, // capsule half-height (cylindrical part)
  maxHealth: 100,
};

export const CAMERA = {
  fov: 50,
  height: 11,
  back: 6.5,
  portraitZoom: 1.2, // pull back a little in portrait so the arena width stays readable
  follow: 8, // follow smoothing (higher = snappier)
  lookAhead: 2.2, // metres the camera leans toward the aim direction
  shakeDecay: 9,
};

/** Touch aim. Turn speeds/accuracy live per weapon (aimTurn, settle, recoilBloom in weapons/weapon.ts). */
export const AIM = {
  /** A lift-shot waits this long (s) for the aim to reach the thumb direction before firing anyway. */
  pendingShotMax: 0.25,
  /** "Arrived" tolerance for a pending lift-shot, radians (~2.3°). */
  arriveTolerance: 0.04,
  /** Aim ease-in (s): a new drag ramps the turn speed up over this long. */
  easeIn: 0.3,
};

export const ARENA = { size: 44, wallHeight: 1.6 };

/** Prop physics. Masses are "game-real": light enough that bullets visibly shove them. */
export const PROPS = {
  crateDensity: 12, // 1.2m crate ≈ 21 kg (pistol rocks it, stacks topple)
  barrelDensity: 30, // ≈ 15 kg (empty drum)
};
