import { describe, it, expect } from 'vitest';
import { AimStickLogic, AIM_DEADZONE, HOLD_TIME, TAP_MAX } from '../src/input/aimStick';

describe('AimStickLogic (drag = aim, tap = shot, hold = fire)', () => {
  it('a quick tap fires one shot', () => {
    const a = new AimStickLogic();
    a.start(10);
    a.move(0.05, 0.02);
    a.update(10.05);
    a.end(10.1);
    expect(a.consumeTap()).toBe(true);
    expect(a.consumeTap()).toBe(false);
    expect(a.consumeHoldStart()).toBe(false);
  });

  it('dragging aims in that exact direction and never fires', () => {
    const a = new AimStickLogic();
    a.start(10);
    a.move(0.6, -0.8);
    expect(a.aiming).toBe(true);
    expect(a.dirX).toBeCloseTo(0.6);
    expect(a.dirY).toBeCloseTo(-0.8);
    a.update(11); // even held for a long time after dragging
    expect(a.firing).toBe(false);
    a.end(11.5);
    expect(a.consumeTap()).toBe(false);
    expect(a.consumeHoldStart()).toBe(false);
  });

  it('touch and hold still → firing starts (one hold-start shot), continues until release', () => {
    const a = new AimStickLogic();
    a.start(10);
    a.update(10 + HOLD_TIME - 0.01);
    expect(a.firing).toBe(false);
    a.update(10 + HOLD_TIME + 0.01);
    expect(a.firing).toBe(true);
    expect(a.consumeHoldStart()).toBe(true);
    expect(a.consumeHoldStart()).toBe(false);
    // Dragging while holding aims (and keeps firing).
    a.move(0.9, 0);
    expect(a.firing).toBe(true);
    expect(a.aiming).toBe(true);
    a.end(12);
    expect(a.firing).toBe(false);
    expect(a.consumeTap()).toBe(false); // releasing a hold is not a tap
  });

  it('a long touch released before the hold threshold is impossible; a slow tap is not a tap', () => {
    expect(HOLD_TIME).toBeLessThan(TAP_MAX + 0.1);
    const a = new AimStickLogic();
    a.start(10);
    a.end(10 + TAP_MAX + 0.05); // never updated → no hold; too slow for a tap
    expect(a.consumeTap()).toBe(false);
  });

  it('has hysteresis at the deadzone edge (no flicker)', () => {
    const a = new AimStickLogic();
    a.start();
    a.move(AIM_DEADZONE * 0.95, 0);
    expect(a.aiming).toBe(false);
    a.move(AIM_DEADZONE * 1.05, 0);
    expect(a.aiming).toBe(true);
    a.move(AIM_DEADZONE * 0.9, 0);
    expect(a.aiming).toBe(true);
  });
});
