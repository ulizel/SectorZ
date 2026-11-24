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
 *  - 💣 button arms a grenade: the right stick then aims the throw (push further = throw further),
 *    lifting the thumb outside the deadzone throws; tapping 💣 again cancels. No shooting while armed.
 */
export class TouchSticks {
  private left: Stick;
  private right: Stick;
  readonly aim = new AimStickLogic();
  private reloadQueued = false;
  private switchQueued = false;
  private grenadeArmed = false;
  private throwQueued: { x: number; y: number; mag: number } | null = null;
  active = false;

  constructor(private readonly layer: HTMLElement, reloadButton: HTMLElement, switchButton: HTMLElement,
    private readonly grenadeButton: HTMLElement) {
    this.left = this.makeStick('move');
    this.right = this.makeStick('aim');
    layer.addEventListener('pointerdown', (e) => this.onDown(e));
    layer.addEventListener('pointermove', (e) => this.onMove(e));
    layer.addEventListener('pointerup', (e) => this.onUp(e));
    layer.addEventListener('pointercancel', (e) => this.onUp(e, true));
    reloadButton.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.reloadQueued = true; });
    switchButton.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.switchQueued = true; });
    grenadeButton.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.setArmed(!this.grenadeArmed); });
  }

  /** Arm / disarm a grenade (the game disarms when there are none left). */
  setArmed(on: boolean): void {
    this.grenadeArmed = on;
    this.grenadeButton.classList.toggle('armed', on);
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
      // Armed grenade: lifting the thumb outside the deadzone throws along the stick.
      if (s === this.right && this.grenadeArmed && this.aim.aiming && !cancelled) {
        this.throwQueued = { x: this.aim.dirX, y: this.aim.dirY, mag: this.aim.mag };
        this.setArmed(false);
      }
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
    const tap = this.aim.consumeTap(), hold = this.aim.consumeHoldStart();
    if (this.throwQueued) {
      out.grenadeThrow = true;
      out.grenadeStick = this.throwQueued;
      this.throwQueued = null;
    } else if (this.grenadeArmed) {
      // Grenade aiming: the stick sets the throw, taps/holds never shoot.
      out.grenadeArmed = true;
      if (this.aim.aiming) out.grenadeStick = { x: this.aim.dirX, y: this.aim.dirY, mag: this.aim.mag };
      this.right.base.classList.remove('firing');
      if (this.reloadQueued) { out.reload = true; this.reloadQueued = false; }
      if (this.switchQueued) { out.switchWeapon = -1; this.switchQueued = false; }
      return;
    }
    if (tap || hold) out.stickTap = true;
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
