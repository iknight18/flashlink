import { describe, expect, it } from 'vitest';
import { buildTransmission, type MultiTimedLevels } from '../src/signal/transmission';
import { runMultiSchedule, type Clock } from '../src/signal/scheduler';
import { simulateLanes, type SimOptions } from '../src/simulator/simulate';
import { MultiReceiver, type MultiEvent } from '../src/multiReceiver';
import { encodeLaneFrame } from '../src/framing/frame';
import { splitMessage } from '../src/framing/lanes';
import { manchesterEncode, type Level } from '../src/modulation/manchester/encode';
import { pulseEncode } from '../src/modulation/pulse/encode';
import { mulberry32 } from '../src/simulator/simulate';

const text = 'Meet me at the north gate at 21:40, and bring the blue umbrella.';

/** Runs a signal through the lane simulator and a MultiReceiver; `ids` maps lane → source id. */
function receive(signal: MultiTimedLevels, sim: SimOptions & { onDelayMsPerLane?: number[] }, ids?: number[]): MultiEvent[] {
  const rx = new MultiReceiver();
  const rand = mulberry32(99);
  return simulateLanes(signal, sim).flatMap((s) => {
    const sources = s.levels.map((level, lane) => ({ id: ids ? ids[lane] : lane, level }));
    if (ids) sources.sort(() => rand() - 0.5); // arrival order inside a frame is arbitrary too
    return rx.push(s.t, sources);
  });
}

const messages = (evs: MultiEvent[]) => evs.flatMap((e) => (e.type === 'message' ? [e.text] : []));

describe('buildTransmission', () => {
  it.each(['pulse', 'manchester'] as const)('encodes each lane frame with %s and pads lanes to one length', (coding) => {
    const sig = buildTransmission(text, { lanes: 3, coding, slotMs: 100, msgId: 5 });
    expect(sig.slotMs).toBe(100);
    expect(sig.lanes).toHaveLength(3);
    const parts = splitMessage(text, 3, 5);
    sig.lanes.forEach((levels, i) => {
      const bits = encodeLaneFrame(parts[i].header, parts[i].chunk);
      const own = coding === 'pulse' ? pulseEncode(bits, 100) : manchesterEncode(bits, 200);
      expect(own.halfBitMs).toBe(100);
      expect(levels.slice(0, own.levels.length)).toEqual(own.levels);
      expect(levels.slice(own.levels.length).every((l) => l === 0)).toBe(true);
    });
    expect(new Set(sig.lanes.map((l) => l.length)).size).toBe(1);
  });

  it('appends gapSlots of darkness to every lane (default 8)', () => {
    const lanes = buildTransmission('hi', { lanes: 2, coding: 'pulse', slotMs: 100, msgId: 0 }).lanes;
    const longest = Math.max(...splitMessage('hi', 2, 0).map((p) => pulseEncode(encodeLaneFrame(p.header, p.chunk), 100).levels.length));
    expect(lanes[0]).toHaveLength(longest + 8);
    const gap3 = buildTransmission('hi', { lanes: 2, coding: 'pulse', slotMs: 100, msgId: 0, gapSlots: 3 }).lanes;
    expect(gap3[0]).toHaveLength(longest + 3);
    expect(lanes.every((l) => l.slice(-8).every((x) => x === 0))).toBe(true);
  });
});

/** Every sleep overshoots by 7 ms, like a busy JS thread. */
class LateClock implements Clock {
  t = 0;
  now = () => this.t;
  sleep = async (ms: number) => {
    this.t += ms + 7;
  };
}

describe('runMultiSchedule', () => {
  it('sets all lanes at the same absolute times and ends dark', async () => {
    const clock = new LateClock();
    const sig: MultiTimedLevels = { slotMs: 50, lanes: [[1, 0, 1, 1, 0], [0, 1, 1, 0, 1], [1, 1, 0, 0, 1]] };
    const calls: { t: number; levels: Level[] }[] = [];
    await runMultiSchedule(sig, (levels) => calls.push({ t: clock.t, levels: [...levels] }), { clock });
    calls.slice(0, 5).forEach((c, i) => {
      expect(c.levels).toEqual(sig.lanes.map((l) => l[i]));
      expect(Math.abs(c.t - i * 50)).toBeLessThanOrEqual(7);
    });
    expect(calls.at(-1)!.levels).toEqual([0, 0, 0]);
    expect(calls.at(-1)!.t).toBeGreaterThanOrEqual(5 * 50);
  });

  it('reports progress and stops on abort, leaving every lane off', async () => {
    const clock = new LateClock();
    const ctrl = new AbortController();
    const set: Level[][] = [];
    await runMultiSchedule({ slotMs: 50, lanes: [[1, 1, 1, 1], [1, 1, 1, 1]] }, (l) => set.push([...l]), {
      clock,
      abort: ctrl.signal,
      onProgress: (done, total) => {
        expect(total).toBe(4);
        if (done === 2) ctrl.abort();
      },
    });
    expect(set).toEqual([[1, 1], [1, 1], [0, 0]]);
  });
});

describe('simulateLanes', () => {
  it('samples every lane on one camera clock', () => {
    const sig = buildTransmission(text, { lanes: 4, coding: 'pulse', slotMs: 100, msgId: 0 });
    const samples = simulateLanes(sig, { fps: 30, jitterMs: 8, noise: 0.03, dropRate: 0.05, seed: 3 });
    expect(samples.every((s) => s.levels.length === 4)).toBe(true);
    const dt = samples.slice(1).map((s, i) => s.t - samples[i].t);
    expect(Math.min(...dt)).toBeCloseTo(1000 / 30, 5);
    expect(Math.max(...dt)).toBeGreaterThan(1000 / 30 + 1); // shared dropped frames
  });

  it('jitters lanes independently and applies per-lane turn-on delay', () => {
    const lane = buildTransmission('x', { lanes: 1, coding: 'pulse', slotMs: 100, msgId: 0 }).lanes[0];
    const sig = { slotMs: 100, lanes: [lane, lane] };
    const same = simulateLanes(sig, { fps: 30, seed: 1 });
    expect(same.every((s) => s.levels[0] === s.levels[1])).toBe(true);
    const jittered = simulateLanes(sig, { fps: 30, jitterMs: 20, seed: 1 });
    expect(jittered.some((s) => s.levels[0] !== s.levels[1])).toBe(true);
    const delayed = simulateLanes(sig, { fps: 30, seed: 1, onDelayMsPerLane: [0, 40] });
    const lit = (k: number) => delayed.filter((s) => s.levels[k] > 0.5).length;
    expect(lit(1)).toBeLessThan(lit(0));
  });
});

describe('MultiReceiver', () => {
  it('decodes ≥90% of 4-lane pulse-length messages at 100 ms slots, 30 fps, seeds 1..100', () => {
    const sig = buildTransmission(text, { lanes: 4, coding: 'pulse', slotMs: 100, msgId: 3 });
    const failed: number[] = [];
    const wrong: string[] = [];
    for (let seed = 1; seed <= 100; seed++) {
      const got = messages(receive(sig, { fps: 30, jitterMs: 8, noise: 0.03, dropRate: 0.01, seed }));
      wrong.push(...got.filter((m) => m !== text).map((m) => `seed ${seed}: ${JSON.stringify(m)}`));
      if (got[0] !== text) failed.push(seed);
    }
    expect(wrong, 'wrong texts emitted').toEqual([]);
    expect((100 - failed.length) / 100, `failed seeds: ${failed.join(', ')}`).toBeGreaterThanOrEqual(0.9);
  });

  it.each(['pulse', 'manchester'] as const)('decodes 9 ideal %s lanes', (coding) => {
    const sig = buildTransmission(text, { lanes: 9, coding, slotMs: 100, msgId: 11 });
    const evs = receive(sig, { fps: 30 });
    expect(evs.filter((e) => e.type === 'message')).toEqual([{ type: 'message', msgId: 11, text, lanes: 9 }]);
  });

  it('reassembles by header when lanes arrive through shuffled source ids', () => {
    const sig = buildTransmission(text, { lanes: 4, coding: 'pulse', slotMs: 100, msgId: 1 });
    expect(messages(receive(sig, { fps: 30, jitterMs: 5, seed: 8 }, [42, 7, 1000, 3]))).toEqual([text]);
  });

  it('streams progress text that only grows, then the message', () => {
    const sig = buildTransmission(text, { lanes: 4, coding: 'pulse', slotMs: 100, msgId: 2 });
    const evs = receive(sig, { fps: 30 });
    const progress = evs.flatMap((e) => (e.type === 'progress' ? [e] : []));
    expect(progress.length).toBeGreaterThan(10);
    expect(progress.every((p) => p.msgId === 2 && p.lanes === 4)).toBe(true);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].text.startsWith(progress[i - 1].text)).toBe(true);
      expect(progress[i].lanesDone).toBeGreaterThanOrEqual(progress[i - 1].lanesDone);
    }
    expect(text.startsWith(progress.at(-1)!.text)).toBe(true);
    // Lanes finish at different times (run lengths depend on the data), so only the
    // contiguous prefix plus one live lane can be shown before the message completes.
    expect(progress.at(-1)!.text.length).toBeGreaterThan(text.length / 4);
    expect(messages(evs)).toEqual([text]);
  });

  it('reports a repeated transmission again', () => {
    const one = buildTransmission(text, { lanes: 3, coding: 'pulse', slotMs: 100, msgId: 4 });
    const sig = { slotMs: 100, lanes: one.lanes.map((l) => [...l, ...l, ...l]) };
    expect(messages(receive(sig, { fps: 30, jitterMs: 5, seed: 2 }))).toEqual([text, text, text]);
  });

  it('reports sources only when they change, and drops a source unseen for 3 s', () => {
    const rx = new MultiReceiver();
    const sourcesEvents = (evs: MultiEvent[]) => evs.filter((e) => e.type === 'sources');
    expect(sourcesEvents(rx.push(0, [{ id: 1, level: 0.1 }]))).toEqual([
      { type: 'sources', sources: [{ id: 1, state: 'HUNTING' }] },
    ]);
    expect(sourcesEvents(rx.push(33, [{ id: 1, level: 0.1 }]))).toEqual([]);
    expect(sourcesEvents(rx.push(66, [{ id: 1, level: 0.1 }, { id: 2, level: 0.1 }]))).toEqual([
      { type: 'sources', sources: [{ id: 1, state: 'HUNTING' }, { id: 2, state: 'HUNTING' }] },
    ]);
    expect(sourcesEvents(rx.push(2900, [{ id: 2, level: 0.1 }]))).toEqual([]);
    expect(sourcesEvents(rx.push(3100, [{ id: 2, level: 0.1 }]))).toEqual([
      { type: 'sources', sources: [{ id: 2, state: 'HUNTING' }] },
    ]);
    expect(rx.receiver(1)).toBeUndefined();
    expect(rx.receiver(2)).toBeDefined();
  });

  it('reports source state changes and errors with the source id', () => {
    const sig = buildTransmission('cut short', { lanes: 1, coding: 'pulse', slotMs: 100, msgId: 0 });
    sig.lanes[0] = sig.lanes[0].slice(0, Math.floor(sig.lanes[0].length * 0.6));
    const evs = receive(sig, { fps: 30 }, [5]);
    const states = evs.flatMap((e) => (e.type === 'sources' ? [e.sources[0].state] : []));
    expect(states).toEqual(['HUNTING', 'LOCKED', 'READING', 'HUNTING']);
    expect(evs).toContainEqual({ type: 'error', sourceId: 5, reason: 'lost' });
  });
});
