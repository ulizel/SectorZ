import { describe, it, expect } from 'vitest';
import { WaveDirector, WAVES, waveTuning, type WaveEvent } from '../src/systems/waves';

const DT = 1 / 60;
describe('WaveDirector', () => {
  it('starts wave 1 after the initial delay, spawns its zombies over time, clears when all are dead', () => {
    const w = new WaveDirector();
    const ev: WaveEvent[] = [];
    let alive = 0, started = false, spawnedTotal = 0;
    for (let t = 0; t < 60 && !(started && w.state === 'break'); t += DT) {
      const n = w.update(DT, alive, 12, ev);
      if (ev.some((e) => e.type === 'waveStart')) { started = true; expect(t).toBeGreaterThan(WAVES.firstDelay - 0.1); }
      alive += n; spawnedTotal += n;
      if (spawnedTotal === waveTuning(1).count) alive = 0; // player kills them all at the end
    }
    expect(w.wave).toBe(1);
    expect(spawnedTotal).toBe(waveTuning(1).count);
    expect(w.state).toBe('break');
  });

  it('never exceeds the concurrency cap', () => {
    const w = new WaveDirector();
    const ev: WaveEvent[] = [];
    let alive = 0;
    for (let t = 0; t < 30; t += DT) { alive += w.update(DT, alive, 4, ev); expect(alive).toBeLessThanOrEqual(4); }
    expect(w.spawned).toBe(4);
  });

  it('waves get bigger, faster and tougher', () => {
    const a = waveTuning(1), b = waveTuning(5);
    expect(b.count).toBeGreaterThan(a.count);
    expect(b.interval).toBeLessThan(a.interval);
    expect(b.speedMul).toBeGreaterThan(a.speedMul);
    expect(b.hpMul).toBeGreaterThan(a.hpMul);
    expect(waveTuning(50).speedMul).toBeLessThanOrEqual(WAVES.maxSpeedMul);
  });
});
