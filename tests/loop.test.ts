import { describe, it, expect } from 'vitest';
import { FixedLoop } from '../src/core/loop';
import { SIM_DT, MAX_STEPS_PER_FRAME } from '../src/config';
import { angleDelta, rng } from '../src/core/math';

describe('FixedLoop', () => {
  it('runs a fixed number of steps per real time regardless of frame rate', () => {
    let steps = 0;
    const loop = new FixedLoop(() => steps++, () => {});
    for (let i = 0; i < 120; i++) loop.advance(1 / 120); // 120 Hz display for 1 s
    expect(steps).toBeGreaterThanOrEqual(59);
    expect(steps).toBeLessThanOrEqual(60);
    steps = 0;
    for (let i = 0; i < 30; i++) loop.advance(1 / 30); // 30 Hz for 1 s
    expect(steps).toBeGreaterThanOrEqual(59);
    expect(steps).toBeLessThanOrEqual(61);
  });

  it('caps catch-up after a long stall (no spiral of death)', () => {
    let steps = 0;
    const loop = new FixedLoop(() => steps++, () => {});
    expect(loop.advance(5)).toBeLessThanOrEqual(MAX_STEPS_PER_FRAME);
    expect(loop.alpha).toBeLessThanOrEqual(1 + 1e-9);
    void SIM_DT;
  });
});

describe('math', () => {
  it('angleDelta takes the short way round', () => {
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6);
    expect(angleDelta(0, 1)).toBeCloseTo(1);
  });
  it('rng is deterministic per seed', () => {
    const a = rng(42), b = rng(42);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });
});
