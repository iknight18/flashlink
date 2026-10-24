import { describe, expect, it } from 'vitest';
import { bytesToBits } from '../src/framing/bits';

describe('bytesToBits', () => {
  it('emits MSB first', () => {
    expect(bytesToBits(new Uint8Array([0xd5]))).toEqual([1, 1, 0, 1, 0, 1, 0, 1]);
  });
  it('concatenates bytes', () => {
    expect(bytesToBits(new Uint8Array([0x01, 0x80]))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });
});
