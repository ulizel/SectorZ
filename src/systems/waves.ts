/**
 * Wave director (pure logic, unit-tested): decides how many zombies each wave has, how fast they
 * trickle in, how tough they are, and when breathers happen. The game spawns what it's told.
 */
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

export type WaveEvent = { type: 'waveStart'; wave: number; count: number } | { type: 'waveClear'; wave: number };

export class WaveDirector {
  wave = 0;
  state: WaveState = 'waiting';
  /** Seconds until the next wave starts (waiting/break). */
  timer = WAVES.firstDelay;
  spawned = 0;
  private spawnT = 0;
  tuning: WaveTuning = waveTuning(1);

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
