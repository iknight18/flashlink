import { describe, expect, it } from 'vitest';
import { lightLevel } from '../src/channels/light/frameLevel';

const W = 96;
const H = 72;

function frame(background: number, spots: { x: number; y: number; size: number; value: number }[] = []): Float32Array {
  const f = new Float32Array(W * H).fill(background);
  for (const s of spots)
    for (let y = s.y; y < s.y + s.size; y++) for (let x = s.x; x < s.x + s.size; x++) f[y * W + x] = s.value;
  return f;
}

const torch = (x: number, y: number, size = 5, value = 0.9) => ({ x, y, size, value });

describe('lightLevel', () => {
  it('reads a uniform frame as zero above its baseline', () => {
    expect(lightLevel(frame(0.3))).toBeCloseTo(0, 5);
  });

  it('gives a small torch spot nearly full contrast wherever it is in the frame', () => {
    for (const [x, y] of [[2, 2], [48, 36], [90, 66]]) {
      expect(lightLevel(frame(0.05, [torch(x, y)])) - lightLevel(frame(0.05))).toBeGreaterThan(0.8);
    }
  });

  it('still sees a torch spot only a few pixels wide', () => {
    expect(lightLevel(frame(0.05, [torch(30, 30, 2)]))).toBeGreaterThan(0.2);
  });

  it('cancels a change in overall brightness (the baseline moves with the room)', () => {
    const dim = lightLevel(frame(0.05, [torch(20, 20)])) - lightLevel(frame(0.05));
    const brighter = lightLevel(frame(0.12, [torch(20, 20)])) - lightLevel(frame(0.12));
    expect(Math.abs(dim - brighter)).toBeLessThan(0.08);
    expect(lightLevel(frame(0.12)) - lightLevel(frame(0.05))).toBeCloseTo(0, 5);
  });

  it('ignores a few hot pixels of sensor noise', () => {
    const f = frame(0.05);
    f[100] = 1;
    f[2000] = 1;
    expect(lightLevel(f)).toBeLessThan(0.15);
  });
});
