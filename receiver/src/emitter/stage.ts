import type { Level } from '@flashlink/protocol';
import { gridLayout } from './logic';

/** Space kept free at the bottom of the stage for the dim Stop button and progress text. */
export const HUD_BAND_PX = 44;
const CURSOR_HIDE_MS = 1500;

/** Places `n` tile elements inside `box` (a positioned element) using the shared grid rules. */
export function layoutTiles(box: HTMLElement, tiles: HTMLElement[], width: number, height: number): void {
  const l = gridLayout(tiles.length, width, height);
  const radius = `${Math.round(l.size * 0.04)}px`;
  tiles.forEach((tile, i) => {
    const s = tile.style;
    s.width = s.height = `${l.size}px`;
    s.transform = `translate(${l.tiles[i].x}px, ${l.tiles[i].y}px)`;
    s.borderRadius = radius;
  });
  box.dataset.cols = String(l.cols);
}

/**
 * The fullscreen black stage the camera looks at. `open()` must be called from the
 * click handler (fullscreen needs a user gesture). Leaving fullscreen or pressing
 * Esc calls `onExit`, which the caller uses to abort the schedule.
 */
export class SendStage {
  onExit: () => void = () => {};

  private readonly tilesBox: HTMLElement;
  private readonly progressEl: HTMLElement;
  private tiles: HTMLElement[] = [];
  private on: boolean[] = [];
  private active = false;
  private wentFullscreen = false;
  private wakeLock: WakeLockSentinel | null = null;
  private cursorTimer = 0;
  private lastProgress = '';

  constructor(private readonly el: HTMLElement) {
    this.tilesBox = el.querySelector<HTMLElement>('#stage-tiles')!;
    this.progressEl = el.querySelector<HTMLElement>('#stage-progress')!;
    el.querySelector<HTMLButtonElement>('#stage-stop')!.addEventListener('click', () => this.exit());

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement === this.el) {
        this.wentFullscreen = true;
        this.layout();
      } else if (this.active && this.wentFullscreen) this.exit();
    });
    document.addEventListener('keydown', (e) => {
      if (this.active && e.key === 'Escape') this.exit();
    });
    document.addEventListener('visibilitychange', () => {
      if (this.active && document.visibilityState === 'visible') void this.acquireWakeLock();
    });
    window.addEventListener('resize', () => this.active && this.layout());
    el.addEventListener('pointermove', () => this.showCursor());
  }

  /** Shows the stage with `n` dark tiles, enters fullscreen and keeps the screen awake. */
  open(n: number): void {
    this.tilesBox.replaceChildren();
    this.tiles = Array.from({ length: n }, () => {
      const t = document.createElement('div');
      t.className = 'send-tile';
      this.tilesBox.append(t);
      return t;
    });
    this.on = this.tiles.map(() => false);
    this.lastProgress = '';
    this.progressEl.textContent = '';
    this.active = true;
    this.wentFullscreen = false;
    this.el.hidden = false;
    document.documentElement.classList.add('is-sending');
    this.layout();
    this.showCursor();
    // Fixed full-viewport stage already covers the page if fullscreen is refused.
    this.el.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
    void this.acquireWakeLock();
  }

  /** Called by the scheduler every slot: plain style writes, only for tiles that change. */
  readonly setLevels = (levels: Level[]): void => {
    for (let i = 0; i < this.tiles.length; i++) {
      const lit = levels[i] === 1;
      if (lit !== this.on[i]) {
        this.on[i] = lit;
        this.tiles[i].style.opacity = lit ? '1' : '0';
      }
    }
  };

  /** Dim corner text; only rewritten when the shown value changes. */
  progress(text: string): void {
    if (text === this.lastProgress) return;
    this.lastProgress = text;
    this.progressEl.textContent = text;
  }

  /** Hides the stage, leaves fullscreen and releases the wake lock. Safe to call twice. */
  close(): void {
    if (!this.active) return;
    this.active = false;
    this.el.hidden = true;
    document.documentElement.classList.remove('is-sending');
    clearTimeout(this.cursorTimer);
    if (document.fullscreenElement === this.el) document.exitFullscreen().catch(() => {});
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  private exit(): void {
    if (!this.active) return;
    this.onExit();
    this.close();
  }

  private layout(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight - HUD_BAND_PX;
    layoutTiles(this.tilesBox, this.tiles, w, h);
  }

  private showCursor(): void {
    this.el.classList.remove('hide-cursor');
    clearTimeout(this.cursorTimer);
    this.cursorTimer = window.setTimeout(() => this.el.classList.add('hide-cursor'), CURSOR_HIDE_MS);
  }

  private async acquireWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator) || (this.wakeLock && !this.wakeLock.released)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      if (!this.active) void this.wakeLock.release();
    } catch {
      // Best effort: refused (battery saver, permissions policy) or unsupported.
    }
  }
}
