export type Bit = 0 | 1;

/** MSB-first bit expansion. */
export function bytesToBits(bytes: Uint8Array): Bit[] {
  const bits: Bit[] = [];
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) bits.push(((byte >> i) & 1) as Bit);
  }
  return bits;
}
