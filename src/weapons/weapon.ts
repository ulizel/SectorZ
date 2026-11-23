/** Weapon definitions are data; behaviour is a small deterministic state machine (unit-tested). */
export interface WeaponDef {
  id: string;
  name: string;
  damage: number;
  fireInterval: number; // s between shots
  magSize: number;
  reloadTime: number; // s
  spread: number; // radians (max half-angle)
  range: number; // m
  impulse: number; // N·s applied to dynamic bodies on hit
  pellets: number;
  /** true: hold-to-fire (fires while trigger held). false: single shot per triggerTap. */
  automatic: boolean;
  shake: number; // camera shake amount
  recoil: number; // visual arm kick 0..1
  aimTurn: number; // max aim turn speed, rad/s (weapon handling)
  settle: number; // how fast accuracy recovers when steady, 1/s
  recoilBloom: number; // accuracy lost per shot
  aimKick: number; // random aim jolt per shot, radians (felt recoil)
  /** Learnable spray pattern: aim jolt per consecutive shot (radians, + = clockwise). Repeats. */
  recoilPattern: number[];
  penetration: number; // material "power" a bullet can spend passing through things
  pushback: number; // m/s the shooter is shoved backwards per shot
  /** Active-reload sweet spot as a fraction of reload progress [start, end]. */
  activeWindow: [number, number];
  /** Play the falling-shell tink after each shot. */
  casingSound: boolean;
}

export const WEAPONS: Record<string, WeaponDef> = {
  pistol: {
    id: 'pistol', name: 'Pistol', damage: 25, fireInterval: 0.2, magSize: 12, reloadTime: 1.1,
    spread: 0.012, range: 40, impulse: 10, pellets: 1, automatic: false, shake: 0.2, recoil: 1,
    aimTurn: 9, settle: 3.5, recoilBloom: 1.2, aimKick: 0,
    recoilPattern: [0], penetration: 0.7, pushback: 0.9, activeWindow: [0.45, 0.62], casingSound: false,
  },
  smg: {
    id: 'smg', name: 'SMG', damage: 14, fireInterval: 0.085, magSize: 30, reloadTime: 1.6,
    spread: 0.03, range: 32, impulse: 6, pellets: 1, automatic: true, shake: 0.1, recoil: 0.55,
    aimTurn: 6, settle: 2.5, recoilBloom: 0.35, aimKick: 0.006,
    recoilPattern: [0.012, 0.016, 0.014, 0.008, -0.004, -0.014, -0.018, -0.012, 0.002, 0.014, 0.018, 0.01],
    penetration: 0.45, pushback: 0.35, activeWindow: [0.5, 0.64], casingSound: false,
  },
};

export type WeaponEvent = 'fired' | 'reloadStart' | 'reloadEnd' | 'dry' | 'activeReload' | 'reloadFumble';

/** A single-shot tap arriving slightly early (during cooldown) is remembered this long. */
const TAP_BUFFER = 0.15;

export class WeaponState {
  ammo: number;
  cooldown = 0;
  reloadLeft = 0;
  private tapBuffer = 0;
  /** One active-reload attempt per reload. */
  activeTried = false;
  /** Shots fired in the current burst (drives the recoil pattern). */
  burst = 0;
  private sinceShot = 99;
  private dryCooldown = 0;

  constructor(readonly def: WeaponDef) {
    this.ammo = def.magSize;
  }

  get reloading(): boolean { return this.reloadLeft > 0; }
  get reloadProgress(): number { return this.reloading ? Math.max(0, 1 - this.reloadLeft / this.def.reloadTime) : 0; }

  /** Abort an in-progress reload (e.g. when switching weapons). */
  cancelReload(): void { this.reloadLeft = 0; this.tapBuffer = 0; }

  /**
   * Advance one tick. `trigger` = held, `tap` = one-shot pull this tick.
   * Automatic weapons fire while held (or on a tap); single-shot weapons fire only on taps.
   * Pushes events into `out` (re-used array to avoid garbage).
   */
  update(dt: number, trigger: boolean, tap: boolean, reloadRequest: boolean, out: WeaponEvent[]): void {
    out.length = 0;
    // Cooldown may go slightly negative: that remainder carries into the next shot so fire
    // rates are exact even when the interval isn't a multiple of the 60 Hz tick.
    this.cooldown -= dt;
    this.sinceShot += dt;
    if (this.sinceShot > 0.3) this.burst = 0; // pause resets the spray pattern
    this.dryCooldown = Math.max(0, this.dryCooldown - dt);
    this.tapBuffer = tap ? TAP_BUFFER : Math.max(0, this.tapBuffer - dt);

    if (this.reloading) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) {
        this.reloadLeft = 0;
        this.ammo = this.def.magSize;
        out.push('reloadEnd');
      }
      else if (reloadRequest && !this.activeTried) this.tryActiveReload(out);
    } else if (reloadRequest && this.ammo < this.def.magSize) {
      this.startReload(out);
    }

    const wants = this.def.automatic ? trigger || this.tapBuffer > 0 : this.tapBuffer > 0;
    if (!wants || this.reloading || this.cooldown > 0) {
      if (this.reloading) this.tapBuffer = 0; // taps during reload are dropped, not queued
      if (!wants || this.reloading) this.cooldown = Math.max(0, this.cooldown); // idle time never banks shots
      return;
    }
    this.tapBuffer = 0;

    if (this.ammo <= 0) {
      if (this.dryCooldown === 0) { out.push('dry'); this.dryCooldown = 0.3; }
      this.startReload(out); // auto-reload on empty
      return;
    }
    this.ammo--;
    this.cooldown = Math.max(this.cooldown, -dt) + this.def.fireInterval;
    this.burst++;
    this.sinceShot = 0;
    out.push('fired');
    if (this.ammo === 0) this.startReload(out);
  }

  private startReload(out: WeaponEvent[]): void {
    if (this.reloading) return;
    this.reloadLeft = this.def.reloadTime;
    this.activeTried = false;
    out.push('reloadStart');
  }

  /** Reload pressed again mid-reload: inside the sweet spot = instant finish, outside = fumble (+0.5 s). */
  private tryActiveReload(out: WeaponEvent[]): void {
    this.activeTried = true;
    const p = this.reloadProgress;
    const [a, b] = this.def.activeWindow;
    if (p >= a && p <= b) {
      this.reloadLeft = 0;
      this.ammo = this.def.magSize;
      out.push('activeReload', 'reloadEnd');
    } else {
      this.reloadLeft += 0.5;
      out.push('reloadFumble');
    }
  }
}
