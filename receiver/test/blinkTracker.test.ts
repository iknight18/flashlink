import { describe, expect, it } from 'vitest';
import { BlinkTracker } from '../src/channels/light/blinkTracker';
import type { Region } from '../src/channels/types';

const W = 48;
const H = 36;
const FRAME = 1000 / 30;

interface Light {
  x: number;
  y: number;
  /** Returns the luma at time t. */
  luma(t: number): number;
}

const blinking = (x: number, y: number, periodMs = 200, low = 0.1, high = 0.6): Light => ({
  x, y, luma: (t) => (Math.floor(t / (periodMs / 2)) % 2 === 0 ? high : low),
});
const steady = (x: number, y: number, value: number): Light => ({ x, y, luma: () => value });

function frame(t: number, lights: Light[], background = 0.1): Float32Array {
  const f = new Float32Array(W * H).fill(background);
  for (const l of lights) f[l.y * W + l.x] = l.luma(t);
  return f;
}

function run(tracker: BlinkTracker, lights: Light[], fromMs: number, toMs: number): number[] {
  const levels: number[] = [];
  for (let t = fromMs; t < toMs; t += FRAME) levels.push(tracker.push(t, frame(t, lights)));
  return levels;
}

function contains(r: Region, x: number, y: number): boolean {
  return x / W >= r.x && x / W < r.x + r.w && y / H >= r.y && y / H < r.y + r.h;
}

describe('BlinkTracker', () => {
  it('starts on the centre of the frame', () => {
    const tracker = new BlinkTracker(W, H);
    expect(contains(tracker.region, W >> 1, H >> 1)).toBe(true);
  });

  it('finds the blinking light, not the brighter steady lamp', () => {
    const tracker = new BlinkTracker(W, H);
    run(tracker, [steady(5, 5, 1.0), blinking(40, 30)], 0, 2000);
    expect(contains(tracker.region, 40, 30)).toBe(true);
  });

  it('reports a single-pixel light with nearly full contrast', () => {
    const tracker = new BlinkTracker(W, H);
    const levels = run(tracker, [blinking(10, 20)], 0, 3000).slice(-30);
    // A plain 5×5 average would swing only 0.5 / 25 = 0.02.
    expect(Math.max(...levels) - Math.min(...levels)).toBeGreaterThan(0.4);
  });

  it('keeps its position while held, even if a stronger light starts blinking', () => {
    const tracker = new BlinkTracker(W, H);
    run(tracker, [blinking(10, 10)], 0, 2000);
    tracker.hold(true);
    run(tracker, [blinking(10, 10, 200, 0.1, 0.3), blinking(40, 30, 200, 0.0, 1.0)], 2000, 4000);
    expect(contains(tracker.region, 10, 10)).toBe(true);
    tracker.hold(false);
    run(tracker, [blinking(10, 10, 200, 0.1, 0.3), blinking(40, 30, 200, 0.0, 1.0)], 4000, 5000);
    expect(contains(tracker.region, 40, 30)).toBe(true);
  });

  it('follows a light that drifts while held, keeping its contrast', () => {
    const tracker = new BlinkTracker(W, H);
    run(tracker, [blinking(10, 18)], 0, 2000);
    tracker.hold(true);
    // The sender's hand drifts: the light moves one cell every 150 ms, 12 cells in total.
    const levels: number[] = [];
    for (let t = 2000; t < 2000 + 12 * 150; t += FRAME) {
      const x = 10 + Math.floor((t - 2000) / 150);
      levels.push(tracker.push(t, frame(t, [blinking(x, 18)])));
    }
    expect(contains(tracker.region, 21, 18)).toBe(true);
    const tail = levels.slice(-15);
    expect(Math.max(...tail) - Math.min(...tail)).toBeGreaterThan(0.3);
  });

  it('does not jump to a distant light while held', () => {
    const tracker = new BlinkTracker(W, H);
    run(tracker, [blinking(10, 10)], 0, 2000);
    tracker.hold(true);
    run(tracker, [blinking(10, 10), blinking(40, 30, 200, 0.0, 1.0)], 2000, 4000);
    expect(contains(tracker.region, 10, 10)).toBe(true);
  });

  it('stays on the last light after it stops blinking', () => {
    const tracker = new BlinkTracker(W, H);
    run(tracker, [blinking(30, 8)], 0, 2000);
    run(tracker, [steady(30, 8, 0.1)], 2000, 6000);
    expect(contains(tracker.region, 30, 8)).toBe(true);
  });

  it('ignores sensor noise below the blink threshold', () => {
    const tracker = new BlinkTracker(W, H);
    run(tracker, [blinking(3, 3, 200, 0.1, 0.12)], 0, 2000);
    expect(contains(tracker.region, W >> 1, H >> 1)).toBe(true);
  });
});
