/** Share of the frame's pixels averaged as "the light": a few dozen pixels on a 96-wide grid. */
const BRIGHTEST_FRACTION = 0.002;

/**
 * Brightness of a light anywhere in the frame, above the frame's own baseline.
 * The light is the mean of the brightest pixels; the baseline is the median pixel,
 * i.e. the room. Subtracting it cancels the room or the picture getting brighter or
 * darker as a whole. Stateless, so there's nothing to track or lose.
 */
export function lightLevel(luma: Float32Array, fraction = BRIGHTEST_FRACTION): number {
  const sorted = luma.slice().sort();
  const k = Math.max(1, Math.round(sorted.length * fraction));
  let sum = 0;
  for (let i = sorted.length - k; i < sorted.length; i++) sum += sorted[i];
  const baseline = sorted[sorted.length >> 1];
  return Math.max(0, sum / k - baseline);
}
