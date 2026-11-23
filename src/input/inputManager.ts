import type { RawInput } from './commands';
import { KeyboardMouse } from './keyboardMouse';
import { TouchSticks } from './touchSticks';

export class InputManager {
  readonly km: KeyboardMouse;
  readonly touch: TouchSticks;
  private raw: RawInput = { moveX: 0, moveY: 0, aimScreen: null, aimStick: null, fire: false, reload: false };
  /** Injected input for automated tests / replays; overrides devices when set. */
  override: Partial<RawInput> | null = null;

  constructor(canvasLayer: HTMLElement, touchLayer: HTMLElement, reloadButton: HTMLElement) {
    this.km = new KeyboardMouse(canvasLayer);
    this.touch = new TouchSticks(touchLayer, reloadButton);
  }

  sample(): RawInput {
    const r = this.raw;
    r.moveX = r.moveY = 0;
    r.aimScreen = r.aimStick = null;
    r.fire = r.reload = false;
    this.km.read(r);
    this.touch.read(r); // touch wins where both present (it writes last)
    if (this.override) Object.assign(r, this.override);
    return r;
  }
}
