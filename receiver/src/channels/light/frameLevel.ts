/** Share of the frame's pixels averaged into the level: about a 2 cm torch at arm's length. */
const BRIGHTEST_FRACTION = 0.005;

/**
 * Brightness of a light anywhere in the frame: the mean of the brightest pixels.
 * Stateless, so there's nothing to track or lose. With the torch on these are the
 * torch; with it off they are the brightest bits of the (dark) background.
 */
export function brightestLevel(luma: Float32Array, fraction = BRIGHTEST_FRACTION): number {
  const k = Math.max(1, Math.round(luma.length * fraction));
  const sorted = luma.slice().sort();
  let sum = 0;
  for (let i = sorted.length - k; i < sorted.length; i++) sum += sorted[i];
  return sum / k;
}
