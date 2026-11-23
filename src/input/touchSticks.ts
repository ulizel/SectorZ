import type { RawInput } from './commands';

interface Stick {
  id: number;
  ox: number; oy: number; // origin
  x: number; y: number; // normalised deflection -1..1
  base: HTMLDivElement;
  knob: HTMLDivElement;
}

const RADIUS = 56; // px of full deflection
const FIRE_THRESHOLD = 0.35;

/**
 * Floating twin sticks: touch anywhere on the left half to move, right half to aim.
 * Pushing the aim stick past FIRE_THRESHOLD fires. Uses Pointer Events (iOS Safari 13+, Android Chrome).
 */
export class TouchSticks {
  private left: Stick;
  private right: Stick;
  private reloadQueued = false;
  active = false;

  constructor(private readonly layer: HTMLElement, reloadButton: HTMLElement) {
    this.left = this.makeStick('move');
    this.right = this.makeStick('aim');
    layer.addEventListener('pointerdown', (e) => this.onDown(e));
    layer.addEventListener('pointermove', (e) => this.onMove(e));
    layer.addEventListener('pointerup', (e) => this.onUp(e));
    layer.addEventListener('pointercancel', (e) => this.onUp(e));
    reloadButton.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.reloadQueued = true; });
  }

  private makeStick(kind: string): Stick {
    const base = document.createElement('div');
    base.className = `stick stick-${kind}`;
    const knob = document.createElement('div');
    knob.className = 'stick-knob';
    base.appendChild(knob);
    this.layer.appendChild(base);
    return { id: -1, ox: 0, oy: 0, x: 0, y: 0, base, knob };
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && !this.active) return; // desktop mouse is handled elsewhere
    const stick = e.clientX < innerWidth / 2 ? this.left : this.right;
    if (stick.id !== -1) return;
    e.preventDefault();
    this.active = true;
    stick.id = e.pointerId;
    stick.ox = e.clientX;
    stick.oy = e.clientY;
    stick.x = stick.y = 0;
    this.layer.setPointerCapture?.(e.pointerId);
    stick.base.style.transform = `translate(${stick.ox - RADIUS}px, ${stick.oy - RADIUS}px)`;
    stick.base.classList.add('on');
    stick.knob.style.transform = 'translate(0px,0px)';
  }

  private onMove(e: PointerEvent): void {
    const stick = e.pointerId === this.left.id ? this.left : e.pointerId === this.right.id ? this.right : null;
    if (!stick) return;
    e.preventDefault();
    let dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    const d = Math.hypot(dx, dy);
    if (d > RADIUS) {
      // Drag the origin along so the stick never "sticks" at the edge.
      const over = d - RADIUS;
      stick.ox += (dx / d) * over;
      stick.oy += (dy / d) * over;
      dx = e.clientX - stick.ox;
      dy = e.clientY - stick.oy;
      stick.base.style.transform = `translate(${stick.ox - RADIUS}px, ${stick.oy - RADIUS}px)`;
    }
    stick.x = dx / RADIUS;
    stick.y = dy / RADIUS;
    stick.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  private onUp(e: PointerEvent): void {
    for (const s of [this.left, this.right]) {
      if (s.id === e.pointerId) {
        s.id = -1;
        s.x = s.y = 0;
        s.base.classList.remove('on');
      }
    }
  }

  read(out: RawInput): void {
    const l = this.left;
    const ll = Math.hypot(l.x, l.y);
    if (ll > 0.12) {
      // Dead zone, then rescale so small pushes give slow walking.
      const m = Math.min(1, (ll - 0.12) / 0.88);
      out.moveX = (l.x / ll) * m;
      out.moveY = (l.y / ll) * m;
    }
    const r = this.right;
    const rl = Math.hypot(r.x, r.y);
    if (rl > 0.15) {
      out.aimStick = { x: r.x / rl, y: r.y / rl };
      if (rl > FIRE_THRESHOLD) out.fire = true;
    }
    if (this.reloadQueued) { out.reload = true; this.reloadQueued = false; }
  }
}
