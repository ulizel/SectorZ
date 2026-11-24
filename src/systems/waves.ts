/**
 * Wave director (pure logic, unit-tested): decides how many zombies each wave has, how fast they
 * trickle in, how tough they are, and when breathers happen. The game spawns what it's told.
 */
import type { ZombieKind } from '../entities/zombie';

export const WAVES = {
  firstDelay: 3, // s before wave 1
  breakTime: 8, // s between waves
  baseCount: 6, // zombies in wave 1
  perWave: 3, // extra zombies per wave
  spawnInterval: 1.6, // s between spawns in wave 1…
  minSpawnInterval: 0.6, // …shrinking to this
  speedPerWave: 0.05, // +5% walk speed per wave
  maxSpeedMul: 1.45,
  hpPerWave: 0.08, // +8% health per wave
};

/** Survival weapon unlocks: the slot becomes usable when this wave starts (pistol is always there). */
export const WEAPON_UNLOCKS: { wave: number; slot: number }[] = [{ wave: 2, slot: 1 }, { wave: 4, slot: 2 }];

export type WaveState = 'waiting' | 'active' | 'break';

export interface WaveTuning { count: number; interval: number; speedMul: number; hpMul: number }

export function waveTuning(n: number): WaveTuning {
  return {
    count: WAVES.baseCount + WAVES.perWave * (n - 1),
    interval: Math.max(WAVES.minSpawnInterval, WAVES.spawnInterval * Math.pow(0.9, n - 1)),
    speedMul: Math.min(WAVES.maxSpeedMul, 1 + WAVES.speedPerWave * (n - 1)),
    hpMul: 1 + WAVES.hpPerWave * (n - 1),
  };
}

/** How many special zombies wave n brings (fixed, not random): they grow one at a time per wave. */
export function waveSpecials(n: number, count: number): { runner: number; exploder: number; brute: number } {
  return {
    runner: n < 3 ? 0 : Math.min(n - 2, Math.round(count * 0.35)), // wave 3: 1, wave 4: 2, …
    exploder: n < 4 ? 0 : Math.min(n - 3, Math.round(count * 0.15)), // wave 4: 1, wave 5: 2, …
    brute: n < 5 ? 0 : Math.min(1 + Math.floor((n - 5) / 2), Math.round(count * 0.2)), // wave 5–6: 1, 7–8: 2, …
  };
}

/**
 * The wave's spawn order: walkers with the specials spread evenly through it (brutes in the
 * second half, as the wave's climax), so every wave has exactly the same, readable mix.
 */
export function waveRoster(n: number, count: number): ZombieKind[] {
  const out: (ZombieKind | null)[] = new Array(count).fill(null);
  const sp = waveSpecials(n, count);
  const place = (kind: ZombieKind, k: number, from: number, to: number) => {
    for (let i = 0; i < k; i++) {
      let at = Math.min(count - 1, Math.floor(from + ((i + 1) * (to - from)) / (k + 1)));
      while (out[at] !== null) at = (at + 1) % count; // next free slot
      out[at] = kind;
    }
  };
  place('brute', sp.brute, count / 2, count);
  place('exploder', sp.exploder, 0, count);
  place('runner', sp.runner, 0, count);
  return out.map((k) => k ?? 'walker');
}

export type WaveEvent = { type: 'waveStart'; wave: number; count: number } | { type: 'waveClear'; wave: number };

export class WaveDirector {
  wave = 0;
  state: WaveState = 'waiting';
  /** Seconds until the next wave starts (waiting/break). */
  timer = WAVES.firstDelay;
  spawned = 0;
  private spawnT = 0;
  tuning: WaveTuning = waveTuning(1);
  /** This wave's spawn order. */
  roster: ZombieKind[] = waveRoster(1, waveTuning(1).count);
  /** Kind of the zombie just handed out by update() (spawned is already incremented). */
  get nextKind(): ZombieKind { return this.roster[this.spawned - 1] ?? 'walker'; }

  /** Zombies of this wave still to come or alive (for the HUD). */
  remaining(alive: number): number { return this.state === 'active' ? this.tuning.count - this.spawned + alive : 0; }

  /**
   * Advance. `alive` = living zombies from this wave; `maxConcurrent` caps simultaneous zombies
   * (performance). Returns how many to spawn this tick; pushes wave events.
   */
  update(dt: number, alive: number, maxConcurrent: number, events: WaveEvent[]): number {
    events.length = 0;
    if (this.state !== 'active') {
      this.timer -= dt;
      if (this.timer > 0) return 0;
      this.wave++;
      this.tuning = waveTuning(this.wave);
      this.roster = waveRoster(this.wave, this.tuning.count);
      this.state = 'active';
      this.spawned = 0;
      this.spawnT = 0.5;
      events.push({ type: 'waveStart', wave: this.wave, count: this.tuning.count });
      return 0;
    }
    if (this.spawned >= this.tuning.count && alive === 0) {
      this.state = 'break';
      this.timer = WAVES.breakTime;
      events.push({ type: 'waveClear', wave: this.wave });
      return 0;
    }
    this.spawnT -= dt;
    if (this.spawnT > 0 || this.spawned >= this.tuning.count || alive >= maxConcurrent) return 0;
    this.spawnT = this.tuning.interval;
    this.spawned++;
    return 1;
  }

  reset(): void {
    this.wave = 0; this.state = 'waiting'; this.timer = WAVES.firstDelay; this.spawned = 0; this.tuning = waveTuning(1);
  }
}
