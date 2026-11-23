import type { RawInput } from './commands';

export class KeyboardMouse {
  private keys = new Set<string>();
  private mouse: { x: number; y: number } | null = null;
  private down = false;
  private pressedQueued = false;
  private reloadQueued = false;
  private switchQueued: number | null = null;
  private grenadeHeld = false;
  private grenadeReleased = false;
  active = false; // becomes true on first mouse/keyboard use

  constructor(target: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.reloadQueued = true;
      if (e.code === 'Digit1') this.switchQueued = 0;
      if (e.code === 'Digit2') this.switchQueued = 1;
      if (e.code === 'Digit3') this.switchQueued = 2;
      if (e.code === 'KeyQ') this.switchQueued = -1;
      if (e.code === 'Space') this.pressedQueued = true;
      if (e.code === 'KeyG') this.grenadeHeld = true;
      this.active = true;
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyG' && this.grenadeHeld) { this.grenadeHeld = false; this.grenadeReleased = true; }
    });
    addEventListener('blur', () => { this.keys.clear(); this.down = false; this.grenadeHeld = false; });
    target.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.mouse = { x: e.clientX, y: e.clientY };
      this.active = true;
    });
    target.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      this.mouse = { x: e.clientX, y: e.clientY };
      this.down = true;
      this.pressedQueued = true; // edge survives even if released before the next sim tick
      this.active = true;
    });
    addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') this.down = false; });
    target.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > 4) this.switchQueued = -1; }, { passive: true });
  }

  read(out: RawInput): void {
    const k = this.keys;
    let x = 0, y = 0;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) y -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y += 1;
    const len = Math.hypot(x, y);
    if (len > 0) { out.moveX = x / len; out.moveY = y / len; }
    if (this.mouse) out.aimScreen = this.mouse;
    out.mouseHeld = this.down || k.has('Space');
    out.mousePressed = this.pressedQueued;
    this.pressedQueued = false;
    if (this.reloadQueued) { out.reload = true; this.reloadQueued = false; }
    if (this.switchQueued !== null) { out.switchWeapon = this.switchQueued; this.switchQueued = null; }
    // Hold G to aim a grenade at the cursor, release to throw.
    out.grenadeArmed = this.grenadeHeld;
    if (this.grenadeReleased) { out.grenadeThrow = true; this.grenadeReleased = false; }
  }
}
