import type { WeaponState } from '../weapons/weapon';

export class Hud {
  private readonly ammo = document.getElementById('ammo')!;
  private readonly weaponName = document.getElementById('weapon-name')!;
  private readonly reloadBar = document.getElementById('reload-bar')!;
  private readonly reloadWrap = document.getElementById('reload')!;
  private readonly health = document.getElementById('health-fill')!;
  private readonly sweet = document.getElementById('reload-sweet')!;
  private lastTried = false;
  private lastAmmo = -1;
  private lastWeapon = '';
  private lastReload = -1;

  update(weapon: WeaponState, health: number, maxHealth: number): void {
    if (weapon.ammo !== this.lastAmmo || weapon.def.id !== this.lastWeapon) {
      this.lastWeapon = weapon.def.id;
      this.ammo.textContent = `${weapon.ammo}`;
      this.ammo.classList.toggle('low', weapon.ammo <= Math.ceil(weapon.def.magSize * 0.25));
      this.weaponName.textContent = weapon.def.name.toUpperCase();
      this.lastAmmo = weapon.ammo;
    }
    const rp = weapon.reloading ? Math.round(weapon.reloadProgress * 100) : -1;
    if (weapon.reloading && rp !== this.lastReload && (rp <= 1 || this.lastReload < 0)) {
      const [a, b] = weapon.def.activeWindow;
      this.sweet.style.left = `${a * 100}%`;
      this.sweet.style.width = `${(b - a) * 100}%`;
      this.reloadWrap.classList.remove('perfect', 'fumble');
    }
    if (weapon.activeTried !== this.lastTried) {
      this.sweet.classList.toggle('used', weapon.activeTried);
      if (weapon.activeTried && weapon.reloading) this.reloadWrap.classList.add('fumble');
      this.lastTried = weapon.activeTried;
    }
    if (rp !== this.lastReload) {
      this.reloadWrap.style.opacity = rp >= 0 ? '1' : '0';
      this.reloadBar.style.width = `${Math.max(0, rp)}%`;
      this.lastReload = rp;
    }
    this.health.style.width = `${(health / maxHealth) * 100}%`;
  }
}
