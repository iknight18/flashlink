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

function run(tracker: BlinkTracker, lights: (t: number) => Light[], fromMs: number, toMs: number): number[] {
  const levels: number[] = [];
  for (let t = fromMs; t < toMs; t += FRAME) levels.push(tracker.push(t, frame(t, lights(t))));
  return levels;
}

const swing = (levels: number[]) => Math.max(...levels) - Math.min(...levels);

function contains(r: Region, x: number, y: number): boolean {
  const cx = (x + 0.5) / W;
  const cy = (y + 0.5) / H;
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
}

describe('BlinkTracker', () => {
  it('starts with the whole frame as its region', () => {
    expect(new BlinkTracker(W, H).region).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('locates the blinking light, not the brighter steady lamp', () => {
    const tracker = new BlinkTracker(W, H);
    run(tracker, () => [steady(5, 5, 1.0), blinking(40, 30)], 0, 2000);
    expect(contains(tracker.region, 40, 30)).toBe(true);
    expect(contains(tracker.region, 5, 5)).toBe(false);
  });

  it('reads a single-pixel light anywhere in the frame with nearly full contrast', () => {
    const tracker = new BlinkTracker(W, H);
    const levels = run(tracker, () => [steady(5, 5, 1.0), blinking(10, 20)], 0, 3000).slice(-30);
    // A plain average of the whole frame would swing only 0.5 / 1728.
    expect(swing(levels)).toBeGreaterThan(0.4);
  });

  it('keeps the contrast while the light drifts across the frame', () => {
    const tracker = new BlinkTracker(W, H);
    // The sender's hand drifts one cell every 150 ms, 20 cells in all.
    const xAt = (t: number) => 10 + Math.min(20, Math.floor(t / 150));
    const levels = run(tracker, (t) => [blinking(xAt(t), 18)], 0, 3000);
    for (let start = 30; start + 15 <= levels.length; start += 15) {
      expect(swing(levels.slice(start, start + 15))).toBeGreaterThan(0.3);
    }
    expect(contains(tracker.region, xAt(3000 - FRAME), 18)).toBe(true);
  });

  it('picks the light up again within half a second after it jumps across the frame', () => {
    const tracker = new BlinkTracker(W, H);
    run(tracker, () => [blinking(5, 5)], 0, 2000);
    const levels = run(tracker, () => [blinking(42, 30)], 2000, 3000);
    expect(swing(levels.slice(15))).toBeGreaterThan(0.3); // from 500 ms after the jump
    expect(contains(tracker.region, 42, 30)).toBe(true);
  });

  it('keeps showing the last position after the light stops blinking', () => {
    const tracker = new BlinkTracker(W, H);
    run(tracker, () => [blinking(30, 8)], 0, 2000);
    run(tracker, () => [steady(30, 8, 0.1)], 2000, 6000);
    expect(contains(tracker.region, 30, 8)).toBe(true);
  });

  it('ignores sensor noise and reads the plain frame average until something blinks', () => {
    const tracker = new BlinkTracker(W, H);
    const levels = run(tracker, () => [blinking(3, 3, 200, 0.1, 0.11)], 0, 2000);
    expect(tracker.region).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(levels.at(-1)).toBeCloseTo(0.1, 2);
  });
});
