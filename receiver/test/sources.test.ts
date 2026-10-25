import { describe, expect, it } from 'vitest';
import { buildTransmission, MultiReceiver, simulateLanes } from '@flashlink/protocol';
import { bestState, EdgeIntervals, liveLanes } from '../src/sources';

describe('bestState', () => {
  it('ranks READING over LOCKED over HUNTING', () => {
    expect(bestState(['HUNTING', 'READING', 'LOCKED'])).toBe('READING');
    expect(bestState(['HUNTING', 'LOCKED'])).toBe('LOCKED');
    expect(bestState(['HUNTING'])).toBe('HUNTING');
  });

  it('counts a light that just finished its lane (DONE) as locked, and no lights as hunting', () => {
    expect(bestState(['DONE', 'HUNTING'])).toBe('LOCKED');
    expect(bestState([])).toBe('HUNTING');
  });
});

describe('EdgeIntervals', () => {
  it('reports the time between threshold crossings of each source separately', () => {
    const e = new EdgeIntervals();
    const out: number[] = [];
    const push = (t: number, id: number, level: number) => out.push(...e.push(t, id, level, 0.5));
    push(0, 1, 0.1);
    push(0, 2, 0.9);
    push(100, 1, 0.9); // first crossing of 1: nothing to measure yet
    push(150, 2, 0.1); // first crossing of 2
    push(300, 1, 0.1); // 200 ms after 1's last crossing
    push(450, 2, 0.9); // 300 ms after 2's
    expect(out).toEqual([200, 300]);
  });

  it('ignores sources without a threshold yet and forgets dropped ones', () => {
    const e = new EdgeIntervals();
    expect(e.push(0, 1, 0.9, null)).toEqual([]);
    e.push(10, 1, 0.1, 0.5);
    e.push(20, 1, 0.9, 0.5);
    e.retain(new Set([2]));
    e.push(30, 1, 0.1, 0.5); // state was forgotten: a first sample again
    expect(e.push(60, 1, 0.9, 0.5)).toEqual([]);
    expect(e.push(90, 1, 0.1, 0.5)).toEqual([30]);
  });
});

describe('liveLanes', () => {
  it('maps each source reading a frame to the lane index in its header', () => {
    const sig = buildTransmission('Two lanes of text here', { lanes: 2, coding: 'pulse', slotMs: 100, msgId: 1 });
    const rx = new MultiReceiver();
    let seen = new Map<number, number>();
    for (const s of simulateLanes(sig, { fps: 30 })) {
      // Lane 0 on source 20, lane 1 on source 10.
      rx.push(s.t, [{ id: 20, level: s.levels[0] }, { id: 10, level: s.levels[1] }]);
      const lanes = liveLanes(rx);
      if (lanes.size === 2) {
        seen = lanes;
        break;
      }
    }
    expect(seen.get(20)).toBe(0);
    expect(seen.get(10)).toBe(1);
  });
});
