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
  automatic: boolean; // hold to keep firing
  shake: number; // camera shake amount
  recoil: number; // visual arm kick 0..1
}

export const WEAPONS: Record<string, WeaponDef> = {
  pistol: {
    id: 'pistol', name: 'Pistol', damage: 25, fireInterval: 0.2, magSize: 12, reloadTime: 1.1,
    spread: 0.025, range: 40, impulse: 10, pellets: 1, automatic: true, shake: 0.18, recoil: 1,
  },
};

export type WeaponEvent = 'fired' | 'reloadStart' | 'reloadEnd' | 'dry';

export class WeaponState {
  ammo: number;
  cooldown = 0;
  reloadLeft = 0;
  private triggerWasDown = false;
  private dryCooldown = 0;

  constructor(readonly def: WeaponDef) {
    this.ammo = def.magSize;
  }

  get reloading(): boolean { return this.reloadLeft > 0; }
  get reloadProgress(): number { return this.reloading ? 1 - this.reloadLeft / this.def.reloadTime : 0; }

  /** Advance one tick. Pushes events into `out` (re-used array to avoid garbage). */
  update(dt: number, trigger: boolean, reloadRequest: boolean, out: WeaponEvent[]): void {
    out.length = 0;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.dryCooldown = Math.max(0, this.dryCooldown - dt);

    if (this.reloading) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) {
        this.reloadLeft = 0;
        this.ammo = this.def.magSize;
        out.push('reloadEnd');
      }
    } else if (reloadRequest && this.ammo < this.def.magSize) {
      this.startReload(out);
    }

    const pressed = trigger && (this.def.automatic || !this.triggerWasDown);
    this.triggerWasDown = trigger;
    if (!pressed || this.reloading || this.cooldown > 0) return;

    if (this.ammo <= 0) {
      if (this.dryCooldown === 0) { out.push('dry'); this.dryCooldown = 0.3; }
      this.startReload(out); // auto-reload on empty
      return;
    }
    this.ammo--;
    this.cooldown = this.def.fireInterval;
    out.push('fired');
    if (this.ammo === 0) this.startReload(out);
  }

  private startReload(out: WeaponEvent[]): void {
    if (this.reloading) return;
    this.reloadLeft = this.def.reloadTime;
    out.push('reloadStart');
  }
}
