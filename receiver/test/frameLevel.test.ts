import { describe, expect, it } from 'vitest';
import { brightestLevel } from '../src/channels/light/frameLevel';

const W = 96;
const H = 72;

function frame(background: number, spots: { x: number; y: number; size: number; value: number }[] = []): Float32Array {
  const f = new Float32Array(W * H).fill(background);
  for (const s of spots)
    for (let y = s.y; y < s.y + s.size; y++) for (let x = s.x; x < s.x + s.size; x++) f[y * W + x] = s.value;
  return f;
}

describe('brightestLevel', () => {
  it('reads a uniform frame as its brightness', () => {
    expect(brightestLevel(frame(0.3))).toBeCloseTo(0.3, 5);
  });

  it('gives a small torch spot nearly full contrast wherever it is in the frame', () => {
    for (const [x, y] of [[2, 2], [48, 36], [90, 66]]) {
      const on = brightestLevel(frame(0.04, [{ x, y, size: 6, value: 0.9 }]));
      const off = brightestLevel(frame(0.04));
      expect(on - off).toBeGreaterThan(0.8);
    }
  });

  it('still sees a torch spot smaller than the sampled share of pixels', () => {
    const on = brightestLevel(frame(0.04, [{ x: 30, y: 30, size: 3, value: 0.9 }]));
    expect(on - 0.04).toBeGreaterThan(0.2);
  });

  it('ignores a few hot pixels of sensor noise', () => {
    const f = frame(0.04);
    f[100] = 1;
    f[2000] = 1;
    expect(brightestLevel(f)).toBeLessThan(0.1);
  });
});
