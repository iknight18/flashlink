import { describe, expect, it } from 'vitest';
import { crc8 } from '../src/framing/crc8';

describe('crc8 (poly 0x07, init 0x00)', () => {
  it('matches the standard check value for "123456789"', () => {
    expect(crc8(new TextEncoder().encode('123456789'))).toBe(0xf4);
  });
  it('is 0 for empty input', () => {
    expect(crc8(new Uint8Array())).toBe(0);
  });
});
