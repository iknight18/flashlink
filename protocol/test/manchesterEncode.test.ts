import { describe, expect, it } from 'vitest';
import {
  calibrationSignal, MANCHESTER_PREAMBLE_BITS, manchesterEncode, withIdleGap,
} from '../src/modulation/manchester/encode';

describe('manchesterEncode', () => {
  it('prepends a 16-bit 1010… preamble', () => {
    const { levels } = manchesterEncode([], 200);
    expect(levels).toHaveLength(2 * MANCHESTER_PREAMBLE_BITS);
    expect(levels.slice(0, 8)).toEqual([1, 0, 0, 1, 1, 0, 0, 1]); // bits 1,0,1,0
  });
  it('maps 1 → high,low and 0 → low,high', () => {
    const sig = manchesterEncode([1, 0, 1], 200);
    expect(sig.halfBitMs).toBe(100);
    expect(sig.levels.slice(2 * MANCHESTER_PREAMBLE_BITS)).toEqual([1, 0, 0, 1, 1, 0]);
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
