import type { MultiReceiver, ReceiverState } from '@flashlink/protocol';

/** What the receiver as a whole is doing: the furthest any light got. */
export type OverallState = 'HUNTING' | 'LOCKED' | 'READING';

/**
 * READING > LOCKED > HUNTING. Any blinking light tends to LOCK, so only READING means a
 * message is really arriving. A light that just finished its lane (DONE) counts as locked:
 * the message as a whole is only done on MultiReceiver's `message` event.
 */
export function bestState(states: Iterable<ReceiverState>): OverallState {
  let best: OverallState = 'HUNTING';
  for (const s of states) {
    if (s === 'READING') return 'READING';
    if (s === 'LOCKED' || s === 'DONE') best = 'LOCKED';
  }
  return best;
}

/**
 * Time between threshold crossings, per source, for the timing histogram. MultiReceiver
 * doesn't surface its receivers' edge intervals, so they are measured here against each
 * receiver's own threshold.
 */
export class EdgeIntervals {
  private readonly bySource = new Map<number, { above: boolean; lastCross: number | null }>();

  push(t: number, id: number, level: number, threshold: number | null): number[] {
    if (threshold === null) return [];
    const above = level > threshold;
    const s = this.bySource.get(id);
    if (!s) {
      this.bySource.set(id, { above, lastCross: null });
      return [];
    }
    if (above === s.above) return [];
    s.above = above;
    const prev = s.lastCross;
    s.lastCross = t;
    return prev === null ? [] : [t - prev];
  }

  /** Forgets sources not in `ids`. */
  retain(ids: Set<number>): void {
    for (const id of this.bySource.keys()) if (!ids.has(id)) this.bySource.delete(id);
  }
}

/**
 * Lane index each source last carried, from the header of the frame it is reading.
 * MultiReceiver has no public accessor for this, so it is read from its private
 * per-source state; display only, and undefined if that internal shape changes.
 */
export function liveLanes(rx: MultiReceiver): Map<number, number> {
  const out = new Map<number, number>();
  const sources = (rx as unknown as { sources?: Map<number, { live?: { header?: { lane?: number } } | null }> }).sources;
  if (!(sources instanceof Map)) return out;
  for (const [id, s] of sources) {
    const lane = s?.live?.header?.lane;
    if (typeof lane === 'number') out.set(id, lane);
  }
  return out;
}
