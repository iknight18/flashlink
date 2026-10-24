import { describe, expect, it } from 'vitest';
import { calibrationSignal, manchesterEncode, withIdleGap } from '../src/modulation/manchester/encode';

describe('manchesterEncode', () => {
  it('maps 1 → high,low and 0 → low,high', () => {
    expect(manchesterEncode([1, 0, 1], 200)).toEqual({ halfBitMs: 100, levels: [1, 0, 0, 1, 1, 0] });
  });
});

describe('withIdleGap', () => {
  it('appends the requested number of dark bit periods', () => {
    expect(withIdleGap({ halfBitMs: 100, levels: [1, 0] }, 2)).toEqual({ halfBitMs: 100, levels: [1, 0, 0, 0, 0, 0] });
  });
});

describe('calibrationSignal', () => {
  it('is an alternating bit pattern filling the duration', () => {
    const sig = calibrationSignal(200, 1000);
    expect(sig.halfBitMs).toBe(100);
    expect(sig.levels).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 1, 0]); // bits 1,0,1,0,1
  });
});
