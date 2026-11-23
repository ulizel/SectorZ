import { MAX_STEPS_PER_FRAME, SIM_DT } from '../config';

/**
 * Fixed-timestep loop: simulation always advances in SIM_DT steps (deterministic-ish,
 * network friendly); rendering runs every animation frame with an interpolation alpha.
 */
export class FixedLoop {
  private acc = 0;
  private last = -1;
  private raf = 0;
  running = false;
  /** Slow motion: 1 = real time, 0.25 = quarter speed (sim still steps at a fixed dt). */
  timeScale = 1;

  constructor(
    private readonly step: (dt: number) => void,
    private readonly render: (alpha: number, frameDt: number) => void,
  ) {}

  /** Advance by a real-time delta. Returns the number of sim steps executed. Exposed for tests. */
  advance(realDt: number): number {
    // Clamp huge gaps (tab switch, debugger) so we don't spiral.
    this.acc += Math.min(realDt * this.timeScale, SIM_DT * MAX_STEPS_PER_FRAME);
    let steps = 0;
    while (this.acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      this.step(SIM_DT);
      this.acc -= SIM_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.acc = Math.min(this.acc, SIM_DT);
    return steps;
  }

  get alpha(): number {
    return this.acc / SIM_DT;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = (t: number) => {
      if (!this.running) return;
      const dt = this.last < 0 ? SIM_DT : (t - this.last) / 1000;
      this.last = t;
      this.advance(dt);
      this.render(this.alpha, dt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    this.last = -1;
    cancelAnimationFrame(this.raf);
  }
}
