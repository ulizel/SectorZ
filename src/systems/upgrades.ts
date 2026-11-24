import type { Player } from '../entities/player';

/**
 * Upgrades offered between waves (pick 1 of 3). Pure logic: each one modifies the player's
 * per-run stats or its weapons' per-run def copies (restart restores the base WEAPONS).
 */
export interface UpgradeTarget {
  player: Player;
  /** Grenade blast radius multiplier (owned by the game). */
  grenadeRadiusMul: number;
}

export interface Upgrade {
  id: string;
  name: string;
  desc: string;
  /** Times it can be taken per run. */
  max: number;
  /** Optional: only offered when this is true. */
  when?: (t: UpgradeTarget) => boolean;
  apply: (t: UpgradeTarget) => void;
}

const eachWeapon = (t: UpgradeTarget, f: (d: Player['weapons'][number]['def']) => Partial<Player['weapons'][number]['def']>) => {
  for (const w of t.player.weapons) w.def = { ...w.def, ...f(w.def) };
};

export const UPGRADES: Upgrade[] = [
  { id: 'damage', name: 'HOLLOW POINTS', desc: '+20% gun damage', max: 5,
    apply: (t) => eachWeapon(t, (d) => ({ damage: d.damage * 1.2 })) },
  { id: 'rate', name: 'HAIR TRIGGER', desc: '+12% fire rate', max: 4,
    apply: (t) => eachWeapon(t, (d) => ({ fireInterval: d.fireInterval / 1.12 })) },
  { id: 'reload', name: 'QUICK HANDS', desc: '+25% reload speed', max: 3,
    apply: (t) => eachWeapon(t, (d) => ({ reloadTime: d.reloadTime / 1.25 })) },
  { id: 'mags', name: 'EXTENDED MAGS', desc: '+30% magazine size', max: 3,
    apply: (t) => {
      eachWeapon(t, (d) => ({ magSize: Math.ceil(d.magSize * 1.3) }));
      // Top up the loaded weapon so the bigger mag is felt right away.
      const w = t.player.weapon;
      const add = Math.min(w.def.magSize - w.ammo, w.reserve);
      if (add > 0) { w.ammo += add; if (w.reserve !== Infinity) w.reserve -= add; }
    } },
  { id: 'health', name: 'TOUGH SKIN', desc: '+25 max health', max: 4,
    apply: (t) => { t.player.maxHealth += 25; t.player.health += 25; } },
  { id: 'medic', name: 'FIELD MEDIC', desc: 'Heal to full', max: Infinity,
    when: (t) => t.player.health < t.player.maxHealth * 0.7,
    apply: (t) => { t.player.health = t.player.maxHealth; } },
  { id: 'speed', name: 'SPRINTER', desc: '+10% move speed', max: 3,
    apply: (t) => { t.player.speedMul *= 1.1; } },
  { id: 'demo', name: 'DEMOLITION', desc: '+1 grenade slot, +2 grenades, +15% blast', max: 3,
    apply: (t) => {
      const p = t.player;
      p.grenadeMax += 1;
      p.grenades = Math.min(p.grenadeMax, p.grenades + 2);
      t.grenadeRadiusMul *= 1.15;
    } },
];

/** Pick `n` different upgrades still available (under their max and allowed right now). */
export function rollUpgrades(t: UpgradeTarget, taken: Map<string, number>, n = 3, rand = Math.random): Upgrade[] {
  const pool = UPGRADES.filter((u) => (taken.get(u.id) ?? 0) < u.max && (!u.when || u.when(t)));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}
