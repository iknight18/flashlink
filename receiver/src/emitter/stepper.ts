import { clampStep, type Range } from './logic';
import { emitterIcon } from './icons';

const HOLD_DELAY_MS = 400;
const REPEAT_MS = 70;
const FAST_REPEAT_MS = 30;
const FAST_AFTER = 12;

/**
 * Wires a `.stepper` (two `[data-dir]` buttons around an output): tap steps once,
 * holding repeats and speeds up, keyboard Enter/Space steps once per press.
 */
export function bindStepper(
  root: HTMLElement,
  range: Range,
  get: () => number,
  set: (value: number) => void,
): { render(): void } {
  const out = root.querySelector<HTMLElement>('[data-value]')!;
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-dir]')];
  let timer = 0;

  const render = () => {
    const v = get();
    out.textContent = String(v);
    for (const b of buttons) b.disabled = Number(b.dataset.dir) < 0 ? v <= range.min : v >= range.max;
  };

  const step = (dir: number): boolean => {
    const before = get();
    const next = clampStep(before, dir, range);
    if (next === before) return false;
    set(next);
    render();
    return true;
  };

  const stop = () => {
    clearTimeout(timer);
    timer = 0;
  };

  for (const b of buttons) {
    const dir = Number(b.dataset.dir);
    b.innerHTML = emitterIcon(dir < 0 ? 'minus' : 'plus', 16);
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // no text selection or focus flicker while holding
      try {
        b.setPointerCapture(e.pointerId); // keep repeating even if the finger slides off
      } catch {
        // Synthetic or already-released pointer: repeat still stops on pointerup.
      }
      stop();
      if (!step(dir)) return;
      let count = 0;
      const repeat = () => {
        if (!step(dir)) return stop();
        count++;
        timer = window.setTimeout(repeat, count > FAST_AFTER ? FAST_REPEAT_MS : REPEAT_MS);
      };
      timer = window.setTimeout(repeat, HOLD_DELAY_MS);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave'] as const) b.addEventListener(type, stop);
    // Pointer presses are handled above; a click with detail 0 comes from the keyboard.
    b.addEventListener('click', (e) => {
      if (e.detail === 0) step(dir);
    });
  }

  render();
  return { render };
}
