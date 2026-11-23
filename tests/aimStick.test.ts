import { describe, it, expect } from 'vitest';
import { AimStickLogic, AIM_DEADZONE, FIRE_ZONE } from '../src/input/aimStick';

describe('AimStickLogic', () => {
  it('a quick tap without dragging is ignored', () => {
    const a = new AimStickLogic();
    a.start();
    a.move(0.05, 0.02);
    expect(a.aiming).toBe(false);
    a.end();
    expect(a.consumeRelease()).toBeNull();
  });

  it('dragging past the deadzone aims in that exact direction', () => {
    const a = new AimStickLogic();
    a.start();
    a.move(0.6, -0.8);
    expect(a.aiming).toBe(true);
    expect(a.dirX).toBeCloseTo(0.6);
    expect(a.dirY).toBeCloseTo(-0.8);
  });

  it('lifting while aiming queues exactly one release shot along the last direction', () => {
    const a = new AimStickLogic();
    a.start();
    a.move(1, 0);
    a.move(0, 1);
    a.end();
    const r = a.consumeRelease();
    expect(r).not.toBeNull();
    expect(r!.x).toBeCloseTo(0);
    expect(r!.y).toBeCloseTo(1);
    expect(a.consumeRelease()).toBeNull(); // consumed once
  });

  it('dragging back into the deadzone cancels aiming and the release shot', () => {
    const a = new AimStickLogic();
    a.start();
    a.move(0.9, 0);
    expect(a.aiming).toBe(true);
    a.move(0.1, 0);
    expect(a.aiming).toBe(false);
    a.end();
    expect(a.consumeRelease()).toBeNull();
  });

  it('re-aiming after a cancel works within the same touch', () => {
    const a = new AimStickLogic();
    a.start();
    a.move(0.9, 0);
    a.move(0, 0);
    a.move(-0.9, 0);
    expect(a.aiming).toBe(true);
    a.end();
    expect(a.consumeRelease()!.x).toBeCloseTo(-1);
  });

  it('has hysteresis at the deadzone edge (no flicker)', () => {
    const a = new AimStickLogic();
    a.start();
    a.move(AIM_DEADZONE * 0.95, 0);
    expect(a.aiming).toBe(false);
    a.move(AIM_DEADZONE * 1.05, 0);
    expect(a.aiming).toBe(true);
    a.move(AIM_DEADZONE * 0.9, 0); // slightly inside, still within hysteresis band
    expect(a.aiming).toBe(true);
  });

  it('automatic fire zone: inner ring only aims, outer ring fires, back in stops', () => {
    const a = new AimStickLogic();
    a.start();
    a.move(0.5, 0);
    expect(a.aiming).toBe(true);
    expect(a.firing).toBe(false);
    a.move(FIRE_ZONE + 0.05, 0);
    expect(a.firing).toBe(true);
    a.move(0.5, 0);
    expect(a.firing).toBe(false);
    expect(a.aiming).toBe(true);
    a.end();
    expect(a.firing).toBe(false);
  });
});
