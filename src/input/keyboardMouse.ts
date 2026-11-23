import type { RawInput } from './commands';

export class KeyboardMouse {
  private keys = new Set<string>();
  private mouse: { x: number; y: number } | null = null;
  private down = false;
  private reloadQueued = false;
  active = false; // becomes true on first mouse/keyboard use

  constructor(target: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.reloadQueued = true;
      this.active = true;
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.down = false; });
    target.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.mouse = { x: e.clientX, y: e.clientY };
      this.active = true;
    });
    target.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      this.mouse = { x: e.clientX, y: e.clientY };
      this.down = true;
      this.active = true;
    });
    addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') this.down = false; });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
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
    if (this.down || k.has('Space')) out.fire = true;
    if (this.reloadQueued) { out.reload = true; this.reloadQueued = false; }
  }
}
