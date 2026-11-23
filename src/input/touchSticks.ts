import type { RawInput } from './commands';
import { AimStickLogic, AIM_DEADZONE } from './aimStick';

interface Stick {
  id: number;
  ox: number; oy: number; // origin
  x: number; y: number; // normalised deflection -1..1
  base: HTMLDivElement;
  knob: HTMLDivElement;
}

const RADIUS = 56; // px of full deflection
const MOVE_DEADZONE = 0.12;

/**
 * Floating twin sticks (Pointer Events: iOS Safari 13+, Android Chrome):
 *  - left half: movement stick, 360°, releasing stops.
 *  - right half: aim stick (see AimStickLogic): deadzone, aim line, lift-to-fire / hold-to-fire, cancel.
 */
export class TouchSticks {
  private left: Stick;
  private right: Stick;
  readonly aim = new AimStickLogic();
  private reloadQueued = false;
  private switchQueued = false;
  active = false;

  constructor(private readonly layer: HTMLElement, reloadButton: HTMLElement, switchButton: HTMLElement) {
    this.left = this.makeStick('move');
    this.right = this.makeStick('aim');
    layer.addEventListener('pointerdown', (e) => this.onDown(e));
    layer.addEventListener('pointermove', (e) => this.onMove(e));
    layer.addEventListener('pointerup', (e) => this.onUp(e));
    layer.addEventListener('pointercancel', (e) => this.onUp(e, true));
    reloadButton.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.reloadQueued = true; });
    switchButton.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.switchQueued = true; });
  }

  private makeStick(kind: string): Stick {
    const base = document.createElement('div');
    base.className = `stick stick-${kind}`;
    const ring = document.createElement('div');
    ring.className = 'stick-deadzone';
    ring.style.width = ring.style.height = `${AIM_DEADZONE * RADIUS * 2}px`;
    if (kind === 'aim') base.appendChild(ring);
    const knob = document.createElement('div');
    knob.className = 'stick-knob';
    base.appendChild(knob);
    this.layer.appendChild(base);
    return { id: -1, ox: 0, oy: 0, x: 0, y: 0, base, knob };
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return; // desktop mouse is handled by KeyboardMouse
    e.preventDefault();
    const stick = e.clientX < innerWidth / 2 ? this.left : this.right;
    if (stick.id !== -1) return; // one thumb per stick
    this.active = true;
    stick.id = e.pointerId;
    stick.ox = e.clientX;
    stick.oy = e.clientY;
    stick.x = stick.y = 0;
    try { this.layer.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
    stick.base.style.transform = `translate(${stick.ox - RADIUS}px, ${stick.oy - RADIUS}px)`;
    stick.base.classList.add('on');
    stick.knob.style.transform = 'translate(0px,0px)';
    if (stick === this.right) this.aim.start(performance.now() / 1000);
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
    if (stick === this.right) {
      this.aim.move(stick.x, stick.y);
      stick.base.classList.toggle('aiming', this.aim.aiming);
    }
  }

  private onUp(e: PointerEvent, cancelled = false): void {
    for (const s of [this.left, this.right]) {
      if (s.id !== e.pointerId) continue;
      s.id = -1;
      s.x = s.y = 0;
      s.base.classList.remove('on', 'aiming', 'firing');
      if (s === this.right) this.aim.end(cancelled ? -1e9 : performance.now() / 1000); // OS-cancelled touch never fires
    }
  }

  read(out: RawInput): void {
    const l = this.left;
    const ll = Math.hypot(l.x, l.y);
    if (ll > MOVE_DEADZONE) {
      // Dead zone, then rescale so small pushes give slow walking.
      const m = Math.min(1, (ll - MOVE_DEADZONE) / (1 - MOVE_DEADZONE));
      out.moveX = (l.x / ll) * m;
      out.moveY = (l.y / ll) * m;
    }
    this.aim.update(performance.now() / 1000);
    if (this.aim.consumeTap() || this.aim.consumeHoldStart()) out.stickTap = true;
    out.stickActive = this.aim.active;
    out.stickFiring = this.aim.firing;
    this.right.base.classList.toggle('firing', this.aim.firing);
    if (this.aim.aiming) {
      out.aimStick = { x: this.aim.dirX, y: this.aim.dirY };
      out.aimStickMag = this.aim.mag;
    }
    if (this.reloadQueued) { out.reload = true; this.reloadQueued = false; }
    if (this.switchQueued) { out.switchWeapon = -1; this.switchQueued = false; }
  }
}
