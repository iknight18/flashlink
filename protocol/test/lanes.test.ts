import { describe, expect, it } from 'vitest';
import { MessageAssembler, splitMessage } from '../src/framing/lanes';
import { encodePayload } from '../src/framing/textCodec';
import { mulberry32 } from '../src/simulator/simulate';

const text = 'Meet me at the north gate at 21:40, and bring the blue umbrella.';

function shuffled<T>(xs: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('splitMessage', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('splits into %i contiguous chunks of near-equal size', (lanes) => {
    const parts = splitMessage(text, lanes, 6);
    const { bytes, compressed } = encodePayload(text);
    expect(parts).toHaveLength(lanes);
    parts.forEach((p, i) => expect(p.header).toEqual({ msgId: 6, lane: i, lanes, compressed }));
    expect(new Uint8Array(parts.flatMap((p) => [...p.chunk]))).toEqual(bytes);
    const sizes = parts.map((p) => p.chunk.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('allows empty chunks when the message has fewer bytes than lanes', () => {
    const parts = splitMessage('hi', 9, 0);
    expect(parts.filter((p) => p.chunk.length === 0).length).toBeGreaterThan(0);
  });

  it('rejects lane counts outside 1–15 and chunks over 255 bytes', () => {
    expect(() => splitMessage(text, 0, 0)).toThrow(RangeError);
    expect(() => splitMessage(text, 16, 0)).toThrow(RangeError);
    expect(() => splitMessage('世'.repeat(100), 1, 0)).toThrow(RangeError);
    expect(() => splitMessage('世'.repeat(100), 2, 0)).not.toThrow();
  });
});

describe('MessageAssembler', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('assembles %i lanes in any arrival order', (lanes) => {
    for (let seed = 1; seed <= 5; seed++) {
      const asm = new MessageAssembler();
      const parts = shuffled(splitMessage(text, lanes, 3), seed);
      const results = parts.map((p) => asm.add(p.header, p.chunk));
      expect(results.slice(0, -1).every((r) => !r.complete)).toBe(true);
      expect(results.at(-1)).toEqual({ text, complete: true });
    }
  });

  it('assembles a message with fewer bytes than lanes', () => {
    const asm = new MessageAssembler();
    const results = splitMessage('hi', 9, 1).map((p) => asm.add(p.header, p.chunk));
    expect(results.at(-1)).toEqual({ text: 'hi', complete: true });
  });

  it('returns the contiguous text so far while incomplete', () => {
    const asm = new MessageAssembler();
    const [a, b, c] = splitMessage(text, 3, 2);
    expect(asm.add(b.header, b.chunk)).toEqual({ text: '', complete: false });
    const first = asm.add(a.header, a.chunk);
    expect(first.complete).toBe(false);
    expect(first.text.length).toBeGreaterThan(text.length / 2);
    expect(text.startsWith(first.text)).toBe(true);
    expect(asm.add(c.header, c.chunk)).toEqual({ text, complete: true });
  });

  it('clears stale partial state when a new msgId arrives', () => {
    const asm = new MessageAssembler();
    const old = splitMessage('the old message', 3, 4);
    const next = splitMessage('a new message!!', 3, 5);
    asm.add(old[0].header, old[0].chunk);
    asm.add(old[1].header, old[1].chunk);
    asm.add(next[0].header, next[0].chunk);
    asm.add(next[1].header, next[1].chunk);
    // Lane 2 of the old message must not complete anything.
    expect(asm.add(old[2].header, old[2].chunk).complete).toBe(false);
    for (const p of next) asm.add(p.header, p.chunk);
    const again = new MessageAssembler();
    next.slice(0, 2).forEach((p) => again.add(p.header, p.chunk));
    expect(again.add(next[2].header, next[2].chunk)).toEqual({ text: 'a new message!!', complete: true });
  });

  it('reports a repeat of a completed message again', () => {
    const asm = new MessageAssembler();
    const parts = splitMessage(text, 4, 7);
    for (let pass = 0; pass < 3; pass++) {
      const results = shuffled(parts, pass).map((p) => asm.add(p.header, p.chunk));
      expect(results.filter((r) => r.complete)).toEqual([{ text, complete: true }]);
      expect(results.at(-1)!.complete).toBe(true);
    }
  });

  it('reports a single-lane message on every repeat', () => {
    const asm = new MessageAssembler();
    const [p] = splitMessage('solo', 1, 0);
    expect(asm.add(p.header, p.chunk)).toEqual({ text: 'solo', complete: true });
    expect(asm.add(p.header, p.chunk)).toEqual({ text: 'solo', complete: true });
  });

  it('counts the lanes received so far', () => {
    const asm = new MessageAssembler();
    const parts = splitMessage(text, 4, 7);
    expect(asm.lanesDone(7)).toBe(0);
    asm.add(parts[2].header, parts[2].chunk);
    asm.add(parts[2].header, parts[2].chunk);
    expect(asm.lanesDone(7)).toBe(1);
    expect(asm.lanesDone(8)).toBe(0);
  });

  describe('preview', () => {
    it('streams contiguous chunks from lane 0 plus the live next lane', () => {
      const asm = new MessageAssembler();
      const parts = splitMessage(text, 3, 1);
      const seen: string[] = [];
      for (const p of parts) {
        for (let n = 0; n <= p.chunk.length; n++) {
          seen.push(asm.preview(1, [{ header: p.header, bytes: p.chunk.slice(0, n) }]));
        }
        asm.add(p.header, p.chunk);
      }
      expect(seen[0]).toBe('');
      expect(seen.at(-1)).toBe(text);
      for (let i = 1; i < seen.length; i++) expect(seen[i].startsWith(seen[i - 1])).toBe(true);
    });

    it('ignores live lanes that are not next in line', () => {
      const asm = new MessageAssembler();
      const [a, b, c] = splitMessage(text, 3, 1);
      asm.add(a.header, a.chunk);
      const base = asm.preview(1);
      expect(asm.preview(1, [{ header: c.header, bytes: c.chunk }])).toBe(base);
      expect(asm.preview(1, [{ header: c.header, bytes: c.chunk }, { header: b.header, bytes: b.chunk.slice(0, 3) }]).length)
        .toBeGreaterThan(base.length);
    });

    it('previews a live lane 0 of a message not yet seen', () => {
      const asm = new MessageAssembler();
      const [a] = splitMessage(text, 2, 9);
      const got = asm.preview(9, [{ header: a.header, bytes: a.chunk }]);
      expect(got.length).toBeGreaterThan(0);
      expect(text.startsWith(got)).toBe(true);
      expect(asm.preview(10)).toBe('');
    });
  });
});
