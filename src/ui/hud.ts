import type { WeaponState } from '../weapons/weapon';

export class Hud {
  private readonly ammo = document.getElementById('ammo')!;
  private readonly weaponName = document.getElementById('weapon-name')!;
  private readonly reloadBar = document.getElementById('reload-bar')!;
  private readonly reloadWrap = document.getElementById('reload')!;
  private readonly health = document.getElementById('health-fill')!;
  private readonly sweet = document.getElementById('reload-sweet')!;
  private readonly reserveEl = document.getElementById('reserve')!;
  private readonly warn = document.getElementById('ammo-warn')!;
  private readonly waveEl = document.getElementById('wave-info')!;
  private readonly bannerEl = document.getElementById('banner')!;
  private readonly toastEl = document.getElementById('toast')!;
  private bannerTimer = 0;
  private toastTimer = 0;
  private lastReserve = -1;
  private lastWave = '';
  private lastTried = false;
  private lastAmmo = -1;
  private lastWeapon = '';
  private lastReload = -1;
  private lastGrenades = -1;
  private readonly grenadeCount = document.getElementById('grenade-count')!;
  private readonly grenadeBtn = document.getElementById('grenade-btn')!;

  update(weapon: WeaponState, health: number, maxHealth: number, grenades: number): void {
    if (grenades !== this.lastGrenades) {
      this.lastGrenades = grenades;
      this.grenadeCount.textContent = `💣${grenades}`;
      this.grenadeBtn.querySelector('span')!.textContent = String(grenades);
      this.grenadeBtn.classList.toggle('empty', grenades === 0);
    }
    if (weapon.reserve !== this.lastReserve || weapon.ammo !== this.lastAmmo || weapon.def.id !== this.lastWeapon) {
      this.lastReserve = weapon.reserve;
      this.reserveEl.textContent = `/ ${weapon.reserve === Infinity ? '∞' : weapon.reserve}`;
      this.warn.textContent = weapon.ammo === 0 && weapon.reserve === 0 ? 'NO AMMO' : weapon.ammo === 0 ? 'RELOAD' : weapon.reserve === 0 ? 'LAST MAG' : '';
    }
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

  /** ⇄ only shows once there's a second weapon to switch to. */
  weaponsUnlocked(n: number): void {
    document.getElementById('switch-btn')!.classList.toggle('locked', n < 2);
  }

  /** Wave status line (top-left HUD column). */
  wave(state: 'waiting' | 'active' | 'break', n: number, left: number, timer: number, choosing = false): void {
    const txt = state === 'active' ? `WAVE ${n} · ${left} LEFT` : choosing ? 'PICK AN UPGRADE' : `NEXT WAVE IN ${Math.ceil(Math.max(0, timer))}`;
    if (txt !== this.lastWave) { this.waveEl.textContent = txt; this.lastWave = txt; }
  }

  /** Upgrade cards (pick 1). Taps/clicks never reach the game's input layer. */
  showUpgrades(list: readonly { name: string; desc: string }[], pick: (i: number) => void): void {
    const el = document.getElementById('upgrades')!, cards = el.querySelector('.cards')!;
    cards.innerHTML = '';
    list.forEach((u, i) => {
      const b = document.createElement('button');
      b.className = 'card';
      b.innerHTML = `<b>${u.name}</b><span>${u.desc}</span>`;
      b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); pick(i); });
      cards.appendChild(b);
    });
    el.classList.add('on');
  }

  hideUpgrades(): void { document.getElementById('upgrades')!.classList.remove('on'); }

  /** Big centred announcement (fades after ~2.5 s). */
  banner(big: string, small = ''): void {
    this.bannerEl.querySelector('.big')!.textContent = big;
    this.bannerEl.querySelector('.small')!.textContent = small;
    this.bannerEl.classList.add('on');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.bannerEl.classList.remove('on'), 2500);
  }

  /** Small pickup message. */
  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('on'), 1200);
  }
}
