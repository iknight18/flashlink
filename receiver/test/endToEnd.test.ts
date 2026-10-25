import { buildTransmission, type MultiEvent, MultiReceiver, mulberry32, simulateLanes } from '@flashlink/protocol';
import { describe, expect, it } from 'vitest';
import { LightFinder } from '../src/channels/light/lightFinder';
import { exposureRamp, laptop, paintScene, shake } from './scene';

/**
 * The phone receiver end to end, without a camera: a simulated transmission's lane levels
 * are painted as bright tiles on a dark 96×72 luma grid (what the camera sensor produces),
 * then LightFinder separates the tiles and MultiReceiver decodes and assembles the lanes.
 */

const W = 96;
const H = 72;
const BG = 0.05;

interface Placement {
  x: number;
  y: number;
  size: number;
}

/** 2×2 grid of tiles, like the emitter page's 4 bulbs seen from across a desk. */
const GRID_2X2: Placement[] = [
  { x: 18, y: 10, size: 14 },
  { x: 62, y: 10, size: 14 },
  { x: 18, y: 46, size: 14 },
  { x: 62, y: 46, size: 14 },
];

/** One camera frame: dark room with sensor noise, each tile at its lane's level. */
function paint(levels: number[], tiles: Placement[], noise: number, rand: () => number): Float32Array {
  const f = new Float32Array(W * H);
  for (let i = 0; i < f.length; i++) f[i] = BG + (rand() * 2 - 1) * noise;
  levels.forEach((level, k) => {
    const { x, y, size } = tiles[k];
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    for (let yy = y0; yy < y0 + size; yy++)
      for (let xx = x0; xx < x0 + size; xx++)
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) f[yy * W + xx] = Math.min(1, level + (rand() * 2 - 1) * noise);
  });
  return f;
}

/** A hand-held frame: laptop bezel and screen, soft tiles at their lane's level, shake and noise. */
function paintHandheld(t: number, levels: number[], tiles: Placement[], rand: () => number): Float32Array {
  const rects = levels.map((level, k) => ({ x: tiles[k].x, y: tiles[k].y, w: tiles[k].size, h: tiles[k].size, value: Math.max(0, level) }));
  return paintScene(W, H, [...laptop(W, H), ...rects], { bg: 0.2, soft: true, noise: 0.03, rand, gain: exposureRamp(t), ...shake(t) });
}

function receive(
  text: string,
  o: {
    lanes: number;
    seed: number;
    passes?: number;
    tiles: (t: number) => Placement[];
    fps?: number;
    /** Hand-held at 60 fps: soft tiles on a laptop screen, the whole picture shaking ±1 cell. */
    handheld?: boolean;
  },
): { events: MultiEvent[]; counts: { t: number; n: number }[]; endMs: number } {
  const signal = buildTransmission(text, { lanes: o.lanes, coding: 'pulse', slotMs: 100, msgId: 3 });
  // A looping emitter sends the same transmission back to back.
  const passes = o.passes ?? 1;
  const looped = { slotMs: signal.slotMs, lanes: signal.lanes.map((l) => Array.from({ length: passes }, () => l).flat()) };
  const frames = simulateLanes(looped, { fps: o.fps ?? 30, jitterMs: 8, noise: 0.03, dropRate: o.handheld ? 0.01 : 0, seed: o.seed, leadInMs: 1500 });
  const finder = new LightFinder(W, H);
  const rx = new MultiReceiver({ edge: { minContrast: 0.04 } });
  const rand = mulberry32(o.seed + 1000);
  const events: MultiEvent[] = [];
  const counts: { t: number; n: number }[] = [];
  for (const { t, levels } of frames) {
    const frame = o.handheld ? paintHandheld(t, levels, o.tiles(t), rand) : paint(levels, o.tiles(t), 0.01, rand);
    const sources = finder.push(t, frame);
    counts.push({ t, n: sources.length });
    events.push(...rx.push(t, sources.map(({ id, level }) => ({ id, level }))));
  }
  return { events, counts, endMs: 1500 + looped.lanes[0].length * looped.slotMs };
}

const messages = (evs: MultiEvent[]) => evs.flatMap((e) => (e.type === 'message' ? [e.text] : []));

describe('camera frames → LightFinder → MultiReceiver', () => {
  const text = 'Meet me at the north gate at 21:40, bring the blue umbrella.';

  it.each([1, 2, 3, 4, 5])('decodes 4 lanes shown as a 2×2 grid of tiles (seed %i)', (seed) => {
    const { events, counts, endMs } = receive(text, { lanes: 4, seed, tiles: () => GRID_2X2 });
    // In the first second of blinking, noisy variance can split a tile into fragments
    // (they expire after holdMs); from then on the finder sees exactly the 4 tiles.
    const settled = counts.filter((c) => c.t > 1500 + 1500 && c.t < endMs - 1000);
    expect(settled.length).toBeGreaterThan(100);
    expect(settled.every((c) => c.n === 4)).toBe(true);
    const got = messages(events);
    expect(got).toContain(text);
    expect(got.filter((m) => m !== text)).toEqual([]);
  });

  it('reports every repeat of a looping 4-lane emitter, with no wrong text', () => {
    const { events } = receive(text, { lanes: 4, seed: 7, passes: 3, tiles: () => GRID_2X2 });
    const got = messages(events);
    expect(got.length).toBeGreaterThanOrEqual(2);
    expect(got.every((m) => m === text)).toBe(true);
  });

  it('streams progress that only grows and ends as the verified text', () => {
    const { events } = receive(text, { lanes: 4, seed: 11, tiles: () => GRID_2X2 });
    const progress = events.flatMap((e) => (e.type === 'progress' ? [e.text] : []));
    expect(progress.length).toBeGreaterThan(0);
    for (let i = 1; i < progress.length; i++) expect(progress[i].length).toBeGreaterThanOrEqual(progress[i - 1].length);
    expect(messages(events)).toEqual([text]);
  });

  it('decodes 1 lane from a tile drifting slowly across the frame', () => {
    const short = 'Drifting hand, steady message.';
    // ~1.5 grid cells per second: a hand-held phone slowly sliding sideways.
    const tiles = (t: number) => [{ x: 30 + (t / 1000) * 1.5, y: 28 + (t / 1000) * 0.5, size: 12 }];
    const { events } = receive(short, { lanes: 1, seed: 3, tiles });
    const got = messages(events);
    expect(got).toContain(short);
    expect(got.filter((m) => m !== short)).toEqual([]);
  });

  describe('hand-held phone at 60 fps (shake, soft tiles, laptop bezel)', () => {
    const tilesFor = (lanes: number): Placement[] =>
      lanes === 1
        ? [{ x: 41, y: 29, size: 14 }]
        : [
            { x: 22, y: 14, size: 14 },
            { x: 60, y: 14, size: 14 },
            { x: 22, y: 42, size: 14 },
            { x: 60, y: 42, size: 14 },
          ];

    it.each([
      [1, 1],
      [1, 2],
      [4, 1],
      [4, 2],
      [4, 3],
    ])('decodes %i lane(s) (seed %i) with no wrong text', (lanes, seed) => {
      // The emitter loops; right after the camera opens, exposure is still settling and a
      // light can take ~1–3 s to be found, so the first pass may be partly missed.
      const { events, counts, endMs } = receive(text, { lanes, seed, passes: 2, fps: 60, handheld: true, tiles: () => tilesFor(lanes) });
      const settled = counts.filter((c) => c.t > 3500 && c.t < endMs - 1000);
      expect(settled.every((c) => c.n === lanes)).toBe(true);
      const got = messages(events);
      expect(got.length).toBeGreaterThanOrEqual(1);
      expect(got.every((m) => m === text)).toBe(true);
    }, 60_000);
  });
});
