import { emptyRaw, type RawInput } from './commands';
import { KeyboardMouse } from './keyboardMouse';
import { TouchSticks } from './touchSticks';

export class InputManager {
  readonly km: KeyboardMouse;
  readonly touch: TouchSticks;
  private raw: RawInput = emptyRaw();

  constructor(layer: HTMLElement, reloadButton: HTMLElement, switchButton: HTMLElement) {
    this.km = new KeyboardMouse(layer);
    this.touch = new TouchSticks(layer, reloadButton, switchButton);
  }

  /** Called once per simulation tick. Edge events (presses, releases) are consumed here. */
  sample(): RawInput {
    Object.assign(this.raw, emptyRaw());
    this.km.read(this.raw);
    this.touch.read(this.raw); // touch wins where both present (it writes last)
    return this.raw;
  }
}
