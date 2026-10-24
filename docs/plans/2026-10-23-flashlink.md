# FlashLink Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Send a text message from an iPhone's flashlight to any camera-equipped device, with the transfer method pluggable so sound can be added later.

**Architecture:** An npm-workspaces TypeScript monorepo. `protocol/` holds all channel-independent logic (framing, Manchester line coding, edge detection, demodulation, the receiver pipeline, the emitter scheduler, and a signal simulator) and is fully unit-tested on Windows. `emitter/` is an Expo Go app whose only light-specific code is a torch on/off `Transmitter`. `receiver/` is a Vite web app whose only light-specific code is a camera-brightness `Sensor`.

**Tech Stack:** TypeScript, Vitest, Expo (React Native, `expo-camera`) running in Expo Go, Vite + `@vitejs/plugin-basic-ssl`, plain DOM (no UI framework) for the receiver.

**Design doc:** `docs/plans/2026-10-23-flashlink-design.md`

**Conventions**
- All paths are relative to `flashlink/`.
- Run commands from `flashlink/` unless stated otherwise. They work in PowerShell and Git Bash.
- Protocol tests: `npm test -w protocol` (runs `vitest run`).

---

### Task 0: Repository scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`

**Step 1: Init git**

Run: `git init`
Expected: `Initialized empty Git repository in .../flashlink/.git/`

**Step 2: Root `package.json`**

```json
{
  "name": "flashlink",
  "private": true,
  "workspaces": ["protocol", "receiver", "emitter"],
  "scripts": {
    "test": "npm test -w protocol",
    "receiver": "npm run dev -w receiver",
    "emitter": "npm run start -w emitter"
  }
}
```

**Step 3: `.gitignore`**

```
node_modules/
dist/
.expo/
*.log
.DS_Store
```

**Step 4: Commit**

```bash
git add package.json .gitignore docs/
git commit -m "chore: scaffold flashlink monorepo with design doc"
```

---

### Task 1: Protocol package, bits and CRC-8

**Files:**
- Create: `protocol/package.json`
- Create: `protocol/tsconfig.json`
- Create: `protocol/src/framing/bits.ts`
- Create: `protocol/src/framing/crc8.ts`
- Create: `protocol/src/index.ts`
- Test: `protocol/test/bits.test.ts`, `protocol/test/crc8.test.ts`

**Step 1: Package files**

`protocol/package.json`:
```json
{
  "name": "@flashlink/protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

`protocol/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

Run: `npm install -D vitest typescript -w protocol`

**Step 2: Write the failing tests**

`protocol/test/bits.test.ts`:
```ts
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
```

`protocol/test/crc8.test.ts`:
```ts
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
```

**Step 3: Run tests to verify they fail**

Run: `npm test -w protocol`
Expected: FAIL, `Cannot find module '../src/framing/bits'`

**Step 4: Implement**

`protocol/src/framing/bits.ts`:
```ts
export type Bit = 0 | 1;

/** MSB-first bit expansion. */
export function bytesToBits(bytes: Uint8Array): Bit[] {
  const bits: Bit[] = [];
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) bits.push(((byte >> i) & 1) as Bit);
  }
  return bits;
}
```

`protocol/src/framing/crc8.ts`:
```ts
/** CRC-8/SMBUS: poly 0x07, init 0x00, no reflection. */
export function crc8(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}
```

`protocol/src/index.ts`:
```ts
export * from './framing/bits';
export * from './framing/crc8';
```

**Step 5: Run tests to verify they pass**

Run: `npm test -w protocol`
Expected: PASS (4 tests)

**Step 6: Commit**

```bash
git add protocol package-lock.json
git commit -m "feat(protocol): add bit expansion and CRC-8"
```

---

### Task 2: Frame encoder and streaming frame decoder

**Files:**
- Create: `protocol/src/framing/frame.ts`
- Modify: `protocol/src/index.ts`
- Test: `protocol/test/frame.test.ts`

**Step 1: Write the failing tests**

`protocol/test/frame.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  encodeFrame, FrameDecoder, MAX_PAYLOAD, PREAMBLE_BITS, type FrameEvent,
} from '../src/framing/frame';
import type { Bit } from '../src/framing/bits';

function decodeAll(bits: Bit[]): FrameEvent[] {
  const dec = new FrameDecoder();
  return bits.map((b) => dec.push(b)).filter((e): e is FrameEvent => e !== null);
}

describe('encodeFrame', () => {
  it('starts with an alternating preamble then the sync byte', () => {
    const bits = encodeFrame('A');
    expect(bits.slice(0, PREAMBLE_BITS)).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(bits.slice(PREAMBLE_BITS, PREAMBLE_BITS + 8)).toEqual([1, 1, 0, 1, 0, 1, 0, 1]);
  });
  it('has preamble + (sync + length + payload + crc) bytes', () => {
    expect(encodeFrame('Hi')).toHaveLength(PREAMBLE_BITS + 8 * (3 + 2));
  });
  it('rejects payloads over MAX_PAYLOAD bytes', () => {
    expect(() => encodeFrame('x'.repeat(MAX_PAYLOAD + 1))).toThrow(RangeError);
  });
});

describe('FrameDecoder', () => {
  it('round-trips ASCII', () => {
    expect(decodeAll(encodeFrame('Hello')).at(-1)).toEqual({ type: 'done', text: 'Hello' });
  });
  it('round-trips multi-byte UTF-8', () => {
    expect(decodeAll(encodeFrame('héllo 👋')).at(-1)).toEqual({ type: 'done', text: 'héllo 👋' });
  });
  it('round-trips an empty message', () => {
    expect(decodeAll(encodeFrame('')).at(-1)).toEqual({ type: 'done', text: '' });
  });
  it('reports header and per-byte progress', () => {
    const events = decodeAll(encodeFrame('ab'));
    expect(events.slice(0, 3)).toEqual([
      { type: 'header', length: 2 },
      { type: 'progress', received: 1, length: 2 },
      { type: 'progress', received: 2, length: 2 },
    ]);
  });
  it('ignores leading garbage before the sync byte', () => {
    const garbage: Bit[] = [0, 0, 1, 1, 0, 0, 1];
    expect(decodeAll([...garbage, ...encodeFrame('ok')]).at(-1)).toEqual({ type: 'done', text: 'ok' });
  });
  it('flags a CRC mismatch with a best guess', () => {
    const bits = encodeFrame('Hello');
    const i = PREAMBLE_BITS + 16 + 7; // last bit of first payload byte
    bits[i] = bits[i] === 1 ? 0 : 1;
    const last = decodeAll(bits).at(-1);
    expect(last).toMatchObject({ type: 'error', reason: 'crc' });
    expect(last && 'bestGuess' in last && last.bestGuess).toBe('Iello');
  });
  it('can decode a second frame after the first', () => {
    const events = decodeAll([...encodeFrame('one'), ...encodeFrame('two')]);
    expect(events.filter((e) => e.type === 'done')).toEqual([
      { type: 'done', text: 'one' },
      { type: 'done', text: 'two' },
    ]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -w protocol`
Expected: FAIL, `Cannot find module '../src/framing/frame'`

**Step 3: Implement**

`protocol/src/framing/frame.ts`:
```ts
import { type Bit, bytesToBits } from './bits';
import { crc8 } from './crc8';

export const PREAMBLE_BITS = 16;
export const SYNC_BYTE = 0xd5;
export const MAX_PAYLOAD = 255;

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** [preamble 1010…][sync][length][payload][crc8(length+payload)] as bits. */
export function encodeFrame(text: string): Bit[] {
  const payload = encoder.encode(text);
  if (payload.length > MAX_PAYLOAD) {
    throw new RangeError(`Payload is ${payload.length} bytes; max is ${MAX_PAYLOAD}`);
  }
  const body = new Uint8Array([payload.length, ...payload]);
  const preamble = Array.from({ length: PREAMBLE_BITS }, (_, i): Bit => (i % 2 === 0 ? 1 : 0));
  return [...preamble, ...bytesToBits(new Uint8Array([SYNC_BYTE, ...body, crc8(body)]))];
}

export type FrameEvent =
  | { type: 'header'; length: number }
  | { type: 'progress'; received: number; length: number }
  | { type: 'done'; text: string }
  | { type: 'error'; reason: 'crc'; bestGuess: string };

/** Consumes demodulated bits one at a time; hunts for the sync byte, then reads one frame. */
export class FrameDecoder {
  private stage: 'sync' | 'length' | 'payload' | 'crc' = 'sync';
  private window = 0;
  private seen = 0;
  private byte = 0;
  private nbits = 0;
  private length = 0;
  private payload: number[] = [];

  get reading(): boolean {
    return this.stage !== 'sync';
  }

  push(bit: Bit): FrameEvent | null {
    if (this.stage === 'sync') {
      this.window = ((this.window << 1) | bit) & 0xff;
      this.seen++;
      if (this.seen >= 8 && this.window === SYNC_BYTE) this.stage = 'length';
      return null;
    }

    this.byte = (this.byte << 1) | bit;
    if (++this.nbits < 8) return null;
    const value = this.byte;
    this.byte = 0;
    this.nbits = 0;

    switch (this.stage) {
      case 'length':
        this.length = value;
        this.payload = [];
        this.stage = value === 0 ? 'crc' : 'payload';
        return { type: 'header', length: value };
      case 'payload':
        this.payload.push(value);
        if (this.payload.length === this.length) this.stage = 'crc';
        return { type: 'progress', received: this.payload.length, length: this.length };
      case 'crc': {
        const body = new Uint8Array([this.length, ...this.payload]);
        const text = new TextDecoder().decode(new Uint8Array(this.payload));
        const ok = crc8(body) === value;
        this.reset();
        return ok ? { type: 'done', text } : { type: 'error', reason: 'crc', bestGuess: text };
      }
    }
    return null;
  }

  reset(): void {
    this.stage = 'sync';
    this.window = 0;
    this.seen = 0;
    this.byte = 0;
    this.nbits = 0;
    this.length = 0;
    this.payload = [];
  }
}
```

Append to `protocol/src/index.ts`:
```ts
export * from './framing/frame';
```

**Step 4: Run tests to verify they pass**

Run: `npm test -w protocol`
Expected: PASS

**Step 5: Commit**

```bash
git add protocol
git commit -m "feat(protocol): add frame encoder and streaming frame decoder"
```

---

### Task 3: Manchester encoder and calibration signal

**Files:**
- Create: `protocol/src/modulation/manchester/encode.ts`
- Modify: `protocol/src/index.ts`
- Test: `protocol/test/manchesterEncode.test.ts`

**Step 1: Write the failing test**

`protocol/test/manchesterEncode.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { calibrationSignal, manchesterEncode } from '../src/modulation/manchester/encode';

describe('manchesterEncode', () => {
  it('maps 1 → high,low and 0 → low,high', () => {
    expect(manchesterEncode([1, 0, 1], 200)).toEqual({ halfBitMs: 100, levels: [1, 0, 0, 1, 1, 0] });
  });
});

describe('calibrationSignal', () => {
  it('is an alternating bit pattern filling the duration', () => {
    const sig = calibrationSignal(200, 1000);
    expect(sig.halfBitMs).toBe(100);
    expect(sig.levels).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 1, 0]); // bits 1,0,1,0,1
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npm test -w protocol`
Expected: FAIL, module not found

**Step 3: Implement**

`protocol/src/modulation/manchester/encode.ts`:
```ts
import type { Bit } from '../../framing/bits';

export type Level = 0 | 1;

/** A sequence of output levels, each held for `halfBitMs`. Channel-agnostic. */
export interface TimedLevels {
  halfBitMs: number;
  levels: Level[];
}

/** IEEE 802.3 convention: 1 = high→low, 0 = low→high (transition at mid-bit). */
export function manchesterEncode(bits: Bit[], bitMs: number): TimedLevels {
  const levels: Level[] = [];
  for (const bit of bits) levels.push(...(bit === 1 ? ([1, 0] as const) : ([0, 1] as const)));
  return { halfBitMs: bitMs / 2, levels };
}

/** Steady 1010… pattern used to measure a channel's real timing jitter. */
export function calibrationSignal(bitMs: number, durationMs: number): TimedLevels {
  const count = Math.floor(durationMs / bitMs);
  return manchesterEncode(Array.from({ length: count }, (_, i): Bit => (i % 2 === 0 ? 1 : 0)), bitMs);
}
```

Append to `protocol/src/index.ts`:
```ts
export * from './modulation/manchester/encode';
```

**Step 4: Run the test to verify it passes**

Run: `npm test -w protocol`
Expected: PASS

**Step 5: Commit**

```bash
git add protocol
git commit -m "feat(protocol): add Manchester encoder and calibration signal"
```

---

### Task 4: Edge detector (adaptive threshold and hysteresis)

Turns raw `(timestamp, level 0–1)` samples from any sensor into clean on/off edges.

**Files:**
- Create: `protocol/src/signal/edgeDetector.ts`
- Modify: `protocol/src/index.ts`
- Test: `protocol/test/edgeDetector.test.ts`

**Step 1: Write the failing test**

`protocol/test/edgeDetector.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { EdgeDetector, type Edge } from '../src/signal/edgeDetector';

function run(det: EdgeDetector, samples: [number, number][]): Edge[] {
  return samples.map(([t, v]) => det.push(t, v)).filter((e): e is Edge => e !== null);
}

describe('EdgeDetector', () => {
  it('detects a rising then falling edge, interpolating the crossing time', () => {
    const samples: [number, number][] = [];
    for (let t = 0; t < 1000; t += 10) samples.push([t, t >= 500 && t < 800 ? 0.9 : 0.1]);
    const edges = run(new EdgeDetector(), samples);
    expect(edges).toHaveLength(2);
    expect(edges[0].level).toBe(1);
    expect(edges[0].t).toBeCloseTo(495, 5); // midway between 490 (0.1) and 500 (0.9)
    expect(edges[1].level).toBe(0);
    expect(edges[1].t).toBeCloseTo(795, 5);
  });

  it('ignores noise below the minimum contrast', () => {
    const samples: [number, number][] = [];
    for (let t = 0; t < 2000; t += 10) samples.push([t, 0.1 + (t % 30 === 0 ? 0.05 : -0.05)]);
    expect(run(new EdgeDetector(), samples)).toEqual([]);
  });

  it('exposes the current threshold once contrast is present', () => {
    const det = new EdgeDetector();
    det.push(0, 0.1);
    expect(det.threshold).toBeNull();
    det.push(10, 0.9);
    expect(det.threshold).toBeCloseTo(0.5, 5);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npm test -w protocol`
Expected: FAIL, module not found

**Step 3: Implement**

`protocol/src/signal/edgeDetector.ts`:
```ts
import type { Level } from '../modulation/manchester/encode';

export interface Edge {
  /** Interpolated time the signal crossed the threshold. */
  t: number;
  /** Level after the edge. */
  level: Level;
}

export interface EdgeDetectorOptions {
  /** Rolling window for min/max tracking. */
  windowMs?: number;
  /** Below this max−min range there is no signal, only noise. */
  minContrast?: number;
  /** Hysteresis band as a fraction of the range, either side of the midpoint. */
  hysteresis?: number;
}

export class EdgeDetector {
  private samples: { t: number; v: number }[] = [];
  private prev: { t: number; v: number } | null = null;
  private level: Level = 0;
  private mid: number | null = null;
  private readonly windowMs: number;
  private readonly minContrast: number;
  private readonly hysteresis: number;

  constructor(opts: EdgeDetectorOptions = {}) {
    this.windowMs = opts.windowMs ?? 2000;
    this.minContrast = opts.minContrast ?? 0.15;
    this.hysteresis = opts.hysteresis ?? 0.2;
  }

  get threshold(): number | null {
    return this.mid;
  }

  push(t: number, v: number): Edge | null {
    const prev = this.prev;
    this.prev = { t, v };
    this.samples.push({ t, v });
    while (this.samples[0].t < t - this.windowMs) this.samples.shift();

    let min = Infinity;
    let max = -Infinity;
    for (const s of this.samples) {
      if (s.v < min) min = s.v;
      if (s.v > max) max = s.v;
    }
    const range = max - min;
    if (range < this.minContrast) {
      this.mid = null;
      return null;
    }

    const mid = (min + max) / 2;
    const band = range * this.hysteresis;
    this.mid = mid;

    let next = this.level;
    if (this.level === 0 && v > mid + band) next = 1;
    else if (this.level === 1 && v < mid - band) next = 0;
    if (next === this.level) return null;
    this.level = next;

    let edgeT = t;
    if (prev && prev.v !== v) {
      const frac = Math.min(1, Math.max(0, (mid - prev.v) / (v - prev.v)));
      edgeT = prev.t + frac * (t - prev.t);
    }
    return { t: edgeT, level: next };
  }
}
```

Append to `protocol/src/index.ts`:
```ts
export * from './signal/edgeDetector';
```

**Step 4: Run the test to verify it passes**

Run: `npm test -w protocol`
Expected: PASS

**Step 5: Commit**

```bash
git add protocol
git commit -m "feat(protocol): add adaptive-threshold edge detector"
```

---

### Task 5: Manchester edge-timing decoder

Locks onto the preamble by finding 8 consistent edge intervals, then classifies each following interval as short (½T) or long (T).

**Files:**
- Create: `protocol/src/modulation/manchester/decode.ts`
- Modify: `protocol/src/index.ts`
- Test: `protocol/test/manchesterDecode.test.ts`

**Step 1: Write the failing test**

`protocol/test/manchesterDecode.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ManchesterDecoder } from '../src/modulation/manchester/decode';
import { manchesterEncode, type TimedLevels } from '../src/modulation/manchester/encode';
import { encodeFrame } from '../src/framing/frame';
import type { Bit } from '../src/framing/bits';
import type { Edge } from '../src/signal/edgeDetector';

/** Ideal edges for a signal, starting from an idle-low line. */
function edgesOf(sig: TimedLevels, t0 = 1000): Edge[] {
  const edges: Edge[] = [];
  let level = 0;
  sig.levels.forEach((l, i) => {
    if (l !== level) edges.push({ t: t0 + i * sig.halfBitMs, level: l });
    level = l;
  });
  return edges;
}

describe('ManchesterDecoder', () => {
  it('locks on the preamble and decodes the remaining bits exactly', () => {
    const bits = encodeFrame('Hi!');
    const dec = new ManchesterDecoder();
    const out: Bit[] = [];
    for (const e of edgesOf(manchesterEncode(bits, 200))) out.push(...dec.pushEdge(e));
    expect(dec.state).toBe('LOCKED');
    expect(out.length).toBeGreaterThan(bits.length - 16);
    expect(out).toEqual(bits.slice(bits.length - out.length));
  });

  it('drops back to HUNTING on an impossible interval', () => {
    const dec = new ManchesterDecoder();
    const edges = edgesOf(manchesterEncode(encodeFrame('x'), 200));
    for (const e of edges.slice(0, 12)) dec.pushEdge(e);
    expect(dec.state).toBe('LOCKED');
    const last = edges[11];
    dec.pushEdge({ t: last.t + 1000, level: last.level === 1 ? 0 : 1 });
    expect(dec.state).toBe('HUNTING');
  });

  it('times out after 3 bit periods without an edge', () => {
    const dec = new ManchesterDecoder();
    const edges = edgesOf(manchesterEncode(encodeFrame('x'), 200));
    for (const e of edges.slice(0, 12)) dec.pushEdge(e);
    const lastT = edges[11].t;
    expect(dec.checkTimeout(lastT + 500)).toBe(false);
    expect(dec.checkTimeout(lastT + 700)).toBe(true);
    expect(dec.state).toBe('HUNTING');
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npm test -w protocol`
Expected: FAIL, module not found

**Step 3: Implement**

`protocol/src/modulation/manchester/decode.ts`:
```ts
import type { Bit } from '../../framing/bits';
import type { Edge } from '../../signal/edgeDetector';

export type DemodState = 'HUNTING' | 'LOCKED';

export interface ManchesterDecoderOptions {
  /** Consistent intervals needed to lock (preamble edges are all one bit apart). */
  lockCount?: number;
  /** Max relative deviation from the median for an interval to count as consistent. */
  tolerance?: number;
}

/** A mid-bit edge going high→low is a 1, low→high is a 0. */
const bitFromEdge = (e: Edge): Bit => (e.level === 0 ? 1 : 0);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Decodes Manchester from the time between edges rather than fixed sample points,
 * which tolerates low frame rates, dropped frames and transmitter jitter.
 */
export class ManchesterDecoder {
  state: DemodState = 'HUNTING';
  /** Current bit period estimate (ms); 0 while hunting. */
  bitMs = 0;

  private lastEdge: Edge | null = null;
  private intervals: number[] = [];
  private phase: 'mid' | 'boundary' = 'mid';
  private pendingShort = 0;
  private readonly lockCount: number;
  private readonly tolerance: number;

  constructor(opts: ManchesterDecoderOptions = {}) {
    this.lockCount = opts.lockCount ?? 8;
    this.tolerance = opts.tolerance ?? 0.3;
  }

  pushEdge(edge: Edge): Bit[] {
    const prev = this.lastEdge;
    this.lastEdge = edge;
    if (!prev) return [];
    const dt = edge.t - prev.t;
    return this.state === 'HUNTING' ? this.hunt(dt, edge) : this.decode(dt, edge);
  }

  /** Call on every sample without an edge; returns true if lock was just lost. */
  checkTimeout(now: number): boolean {
    if (this.state !== 'LOCKED' || !this.lastEdge) return false;
    if (now - this.lastEdge.t <= 3 * this.bitMs) return false;
    this.reset();
    this.lastEdge = null;
    return true;
  }

  reset(): void {
    this.state = 'HUNTING';
    this.bitMs = 0;
    this.intervals = [];
    this.phase = 'mid';
    this.pendingShort = 0;
  }

  private hunt(dt: number, edge: Edge): Bit[] {
    this.intervals.push(dt);
    if (this.intervals.length > this.lockCount) this.intervals.shift();
    if (this.intervals.length < this.lockCount) return [];
    const m = median(this.intervals);
    if (!this.intervals.every((x) => Math.abs(x - m) <= this.tolerance * m)) return [];
    this.state = 'LOCKED';
    this.bitMs = m;
    this.intervals = [];
    this.phase = 'mid';
    return [bitFromEdge(edge)];
  }

  private decode(dt: number, edge: Edge): Bit[] {
    const ratio = dt / this.bitMs;
    if (ratio < 0.75) {
      // short: half a bit
      if (this.phase === 'mid') {
        this.phase = 'boundary';
        this.pendingShort = dt;
        return [];
      }
      this.adapt(this.pendingShort + dt);
      this.phase = 'mid';
      return [bitFromEdge(edge)];
    }
    if (ratio < 1.5 && this.phase === 'mid') {
      // long: a full bit, mid-edge to mid-edge
      this.adapt(dt);
      return [bitFromEdge(edge)];
    }
    this.reset();
    return [];
  }

  private adapt(period: number): void {
    this.bitMs = 0.8 * this.bitMs + 0.2 * period;
  }
}
```

Append to `protocol/src/index.ts`:
```ts
export * from './modulation/manchester/decode';
```

**Step 4: Run the test to verify it passes**

Run: `npm test -w protocol`
Expected: PASS

**Step 5: Commit**

```bash
git add protocol
git commit -m "feat(protocol): add Manchester edge-timing decoder with clock lock"
```

---

### Task 6: Simulator and receiver pipeline (end-to-end on Windows)

**Files:**
- Create: `protocol/src/simulator/simulate.ts`
- Create: `protocol/src/receiver.ts`
- Modify: `protocol/src/index.ts`
- Test: `protocol/test/receiver.test.ts`

**Step 1: Write the simulator**

This is test infrastructure, so it gets no test of its own. `protocol/src/simulator/simulate.ts`:
```ts
import type { TimedLevels } from '../modulation/manchester/encode';

export interface SimOptions {
  fps: number;
  /** Uniform ± jitter applied to each transmitted edge. Keep < halfBit/2. */
  jitterMs?: number;
  /** Uniform ± noise added to every sample level. */
  noise?: number;
  /** Probability that a camera frame is dropped. */
  dropRate?: number;
  seed?: number;
  leadInMs?: number;
  tailMs?: number;
  low?: number;
  high?: number;
}

export interface Sample {
  t: number;
  level: number;
}

/** Deterministic PRNG so tests are reproducible. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Renders transmitted levels as a sensor would sample them. */
export function simulate(signal: TimedLevels, o: SimOptions): Sample[] {
  const rand = mulberry32(o.seed ?? 1);
  const jitter = o.jitterMs ?? 0;
  const noise = o.noise ?? 0;
  const drop = o.dropRate ?? 0;
  const lead = o.leadInMs ?? 1000;
  const tail = o.tailMs ?? 1000;
  const low = o.low ?? 0.1;
  const high = o.high ?? 0.9;

  const starts = signal.levels.map(
    (_, i) => lead + i * signal.halfBitMs + (i === 0 ? 0 : (rand() * 2 - 1) * jitter),
  );
  const end = lead + signal.levels.length * signal.halfBitMs;
  const frame = 1000 / o.fps;

  const out: Sample[] = [];
  let seg = -1;
  for (let t = rand() * frame; t <= end + tail; t += frame) {
    while (seg + 1 < starts.length && starts[seg + 1] <= t) seg++;
    if (rand() < drop) continue;
    const on = seg >= 0 && t < end && signal.levels[seg] === 1;
    out.push({ t, level: (on ? high : low) + (rand() * 2 - 1) * noise });
  }
  return out;
}
```

**Step 2: Write the failing end-to-end tests**

`protocol/test/receiver.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Receiver, type ReceiverEvent } from '../src/receiver';
import { encodeFrame } from '../src/framing/frame';
import { manchesterEncode } from '../src/modulation/manchester/encode';
import { simulate, type SimOptions } from '../src/simulator/simulate';

function transmit(text: string, bitMs: number, sim: SimOptions): ReceiverEvent[] {
  const rx = new Receiver();
  const events: ReceiverEvent[] = [];
  for (const s of simulate(manchesterEncode(encodeFrame(text), bitMs), sim)) {
    events.push(...rx.push(s.t, s.level));
  }
  return events;
}

const messages = (evs: ReceiverEvent[]) =>
  evs.flatMap((e) => (e.type === 'message' ? [e.text] : []));
const states = (evs: ReceiverEvent[]) =>
  evs.flatMap((e) => (e.type === 'state' ? [e.state] : []));

describe('Receiver end-to-end (simulated camera)', () => {
  it('decodes an ideal 30 fps signal at 200 ms/bit', () => {
    const evs = transmit('Hello', 200, { fps: 30 });
    expect(messages(evs)).toEqual(['Hello']);
    expect(states(evs)).toEqual(['LOCKED', 'READING', 'DONE']);
  });

  it.each([1, 2, 3, 4, 5])('decodes with jitter, noise and dropped frames (seed %i)', (seed) => {
    const evs = transmit('Hello, FlashLink! 👋', 200, {
      fps: 30, jitterMs: 8, noise: 0.05, dropRate: 0.01, seed,
    });
    expect(messages(evs)).toEqual(['Hello, FlashLink! 👋']);
  });

  it('decodes a long message at 100 ms/bit and 60 fps', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(2).trim();
    expect(messages(transmit(text, 100, { fps: 60, jitterMs: 4, noise: 0.03, seed: 7 }))).toEqual([text]);
  });

  it('decodes at 400 ms/bit with heavier jitter', () => {
    expect(messages(transmit('slow & steady', 400, { fps: 30, jitterMs: 20, noise: 0.05, seed: 3 })))
      .toEqual(['slow & steady']);
  });

  it('reports lost signal when the light stops mid-frame', () => {
    const sig = manchesterEncode(encodeFrame('this gets cut off'), 200);
    sig.levels = sig.levels.slice(0, Math.floor(sig.levels.length * 0.6));
    const rx = new Receiver();
    const evs = simulate(sig, { fps: 30 }).flatMap((s) => rx.push(s.t, s.level));
    expect(evs).toContainEqual({ type: 'error', reason: 'lost' });
    expect(messages(evs)).toEqual([]);
  });

  it('emits edge intervals for the calibration histogram', () => {
    const evs = transmit('x', 200, { fps: 30 });
    expect(evs.some((e) => e.type === 'interval')).toBe(true);
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `npm test -w protocol`
Expected: FAIL, `Cannot find module '../src/receiver'`

**Step 4: Implement the receiver pipeline**

`protocol/src/receiver.ts`:
```ts
import { FrameDecoder } from './framing/frame';
import { ManchesterDecoder, type ManchesterDecoderOptions } from './modulation/manchester/decode';
import { EdgeDetector, type EdgeDetectorOptions } from './signal/edgeDetector';

export type ReceiverState = 'HUNTING' | 'LOCKED' | 'READING' | 'DONE' | 'ERROR';

export type ReceiverEvent =
  | { type: 'state'; state: ReceiverState }
  | { type: 'interval'; ms: number }
  | { type: 'progress'; received: number; length: number }
  | { type: 'message'; text: string }
  | { type: 'error'; reason: 'crc'; bestGuess: string }
  | { type: 'error'; reason: 'lost' };

export interface ReceiverOptions {
  edge?: EdgeDetectorOptions;
  demod?: ManchesterDecoderOptions;
}

/** Sensor samples in, decoded messages out. Channel-agnostic: any sensor producing levels works. */
export class Receiver {
  state: ReceiverState = 'HUNTING';
  private readonly edges: EdgeDetector;
  private readonly demod: ManchesterDecoder;
  private readonly frame = new FrameDecoder();
  private lastEdgeT: number | null = null;

  constructor(opts: ReceiverOptions = {}) {
    this.edges = new EdgeDetector(opts.edge);
    this.demod = new ManchesterDecoder(opts.demod);
  }

  get threshold(): number | null {
    return this.edges.threshold;
  }

  push(t: number, level: number): ReceiverEvent[] {
    const events: ReceiverEvent[] = [];
    const edge = this.edges.push(t, level);
    if (!edge) {
      if (this.demod.checkTimeout(t)) this.onLost(events);
      return events;
    }

    if (this.lastEdgeT !== null) events.push({ type: 'interval', ms: edge.t - this.lastEdgeT });
    this.lastEdgeT = edge.t;

    const wasLocked = this.demod.state === 'LOCKED';
    const bits = this.demod.pushEdge(edge);
    if (wasLocked && this.demod.state === 'HUNTING') {
      this.onLost(events);
      return events;
    }
    if (!wasLocked && this.demod.state === 'LOCKED') this.setState('LOCKED', events);

    for (const bit of bits) {
      const ev = this.frame.push(bit);
      if (!ev) continue;
      if (ev.type === 'header') {
        this.setState('READING', events);
        events.push({ type: 'progress', received: 0, length: ev.length });
      } else if (ev.type === 'progress') {
        events.push(ev);
      } else if (ev.type === 'done') {
        events.push({ type: 'message', text: ev.text });
        this.finish('DONE', events);
        break;
      } else {
        events.push({ type: 'error', reason: 'crc', bestGuess: ev.bestGuess });
        this.finish('ERROR', events);
        break;
      }
    }
    return events;
  }

  private onLost(events: ReceiverEvent[]): void {
    const wasReading = this.frame.reading;
    this.frame.reset();
    if (wasReading) {
      events.push({ type: 'error', reason: 'lost' });
      this.setState('ERROR', events);
    } else if (this.state === 'LOCKED') {
      this.setState('HUNTING', events);
    }
  }

  private finish(state: ReceiverState, events: ReceiverEvent[]): void {
    this.demod.reset();
    this.frame.reset();
    this.setState(state, events);
  }

  private setState(state: ReceiverState, events: ReceiverEvent[]): void {
    if (state === this.state) return;
    this.state = state;
    events.push({ type: 'state', state });
  }
}
```

Append to `protocol/src/index.ts`:
```ts
export * from './receiver';
export * from './simulator/simulate';
```

**Step 5: Run tests to verify they pass**

Run: `npm test -w protocol`
Expected: PASS (all suites)

If a jittered seed fails, **do not loosen the test**. Debug it with @superpowers:systematic-debugging: log the `interval` events next to `demod.bitMs` and find which interval was misclassified. The likely culprits are the 0.75/1.5 thresholds or the `adapt` weighting.

**Step 6: Typecheck**

Run: `npm run typecheck -w protocol`
Expected: no output, exit 0

**Step 7: Commit**

```bash
git add protocol
git commit -m "feat(protocol): add receiver pipeline and signal simulator with end-to-end tests"
```

---

### Task 7: Drift-free emitter scheduler

**Files:**
- Create: `protocol/src/signal/scheduler.ts`
- Modify: `protocol/src/index.ts`
- Test: `protocol/test/scheduler.test.ts`

**Step 1: Write the failing test**

`protocol/test/scheduler.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { runSchedule, type Clock } from '../src/signal/scheduler';
import type { Level } from '../src/modulation/manchester/encode';

/** Every sleep overshoots by 7 ms, like a busy JS thread. */
class LateClock implements Clock {
  t = 0;
  now = () => this.t;
  sleep = async (ms: number) => {
    this.t += ms + 7;
  };
}

describe('runSchedule', () => {
  it('sets each level at its absolute target time without accumulating drift', async () => {
    const clock = new LateClock();
    const calls: { t: number; level: Level }[] = [];
    const levels: Level[] = [1, 0, 0, 1, 1, 0, 1, 0, 0, 1];
    await runSchedule({ halfBitMs: 50, levels }, (level) => calls.push({ t: clock.t, level }), { clock });

    expect(calls.slice(0, levels.length).map((c) => c.level)).toEqual(levels);
    calls.slice(0, levels.length).forEach((c, i) => {
      expect(Math.abs(c.t - i * 50)).toBeLessThanOrEqual(7);
    });
    expect(calls.at(-1)).toMatchObject({ level: 0 }); // always ends dark
    expect(calls.at(-1)!.t).toBeGreaterThanOrEqual(levels.length * 50);
  });

  it('reports progress and stops on abort, leaving the output off', async () => {
    const clock = new LateClock();
    const ctrl = new AbortController();
    const set: Level[] = [];
    const progress: number[] = [];
    await runSchedule({ halfBitMs: 50, levels: [1, 1, 1, 1, 1, 1] }, (l) => set.push(l), {
      clock,
      abort: ctrl.signal,
      onProgress: (done) => {
        progress.push(done);
        if (done === 2) ctrl.abort();
      },
    });
    expect(progress).toEqual([1, 2]);
    expect(set).toEqual([1, 1, 0]);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npm test -w protocol`
Expected: FAIL, module not found

**Step 3: Implement**

`protocol/src/signal/scheduler.ts`:
```ts
import type { Level, TimedLevels } from '../modulation/manchester/encode';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

export interface ScheduleOptions {
  onProgress?: (done: number, total: number) => void;
  abort?: AbortSignal;
  clock?: Clock;
}

/**
 * Plays levels on any output. Targets absolute timestamps (start + i·halfBit)
 * so late timers don't accumulate drift. Always leaves the output at 0.
 */
export async function runSchedule(
  signal: TimedLevels,
  setLevel: (level: Level) => void,
  opts: ScheduleOptions = {},
): Promise<void> {
  const clock = opts.clock ?? realClock;
  const total = signal.levels.length;
  const start = clock.now();
  try {
    for (let i = 0; i < total; i++) {
      if (opts.abort?.aborted) return;
      const wait = start + i * signal.halfBitMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
      if (opts.abort?.aborted) return;
      setLevel(signal.levels[i]);
      opts.onProgress?.(i + 1, total);
    }
    const tail = start + total * signal.halfBitMs - clock.now();
    if (tail > 0) await clock.sleep(tail);
  } finally {
    setLevel(0);
  }
}
```

Append to `protocol/src/index.ts`:
```ts
export * from './signal/scheduler';
```

**Step 4: Run the test to verify it passes**

Run: `npm test -w protocol`
Expected: PASS

**Step 5: Commit**

```bash
git add protocol
git commit -m "feat(protocol): add drift-free level scheduler for emitters"
```

---

### Task 8: Receiver web app, scaffold and light channel

**Files:**
- Create: `receiver/package.json`, `receiver/tsconfig.json`, `receiver/vite.config.ts`
- Create: `receiver/src/channels/types.ts`
- Create: `receiver/src/channels/registry.ts`
- Create: `receiver/src/channels/light/cameraSensor.ts`

**Step 1: Package and config**

`receiver/package.json`:
```json
{
  "name": "@flashlink/receiver",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@flashlink/protocol": "*"
  }
}
```

Run: `npm install -D vite @vitejs/plugin-basic-ssl typescript -w receiver`

`receiver/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "vite.config.ts"]
}
```

`receiver/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for camera access on phones; host: true exposes it on the LAN.
export default defineConfig({
  plugins: [basicSsl()],
  server: { host: true },
});
```

**Step 2: Channel interfaces and registry**

`receiver/src/channels/types.ts`:
```ts
export interface Sensor {
  id: string;
  label: string;
  /** Starts the hardware and reports one normalized level (0–1) per reading. */
  start(onSample: (timestampMs: number, level: number) => void): Promise<void>;
  stop(): void;
}

export interface SensorContext {
  video: HTMLVideoElement;
}

export interface ChannelDefinition {
  id: string;
  label: string;
  create(ctx: SensorContext): Sensor;
}
```

`receiver/src/channels/registry.ts`:
```ts
import type { ChannelDefinition } from './types';
import { CameraLightSensor } from './light/cameraSensor';

// Add new channels (e.g. sound via microphone) here.
export const channels: ChannelDefinition[] = [
  { id: 'light', label: 'Light (camera)', create: ({ video }) => new CameraLightSensor(video) },
];
```

**Step 3: Camera light sensor**

`receiver/src/channels/light/cameraSensor.ts`:
```ts
import type { Sensor } from '../types';

type FrameMeta = { captureTime?: number; expectedDisplayTime: number };
type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback(cb: (now: number, meta: FrameMeta) => void): number;
  cancelVideoFrameCallback(handle: number): void;
};

/** Average luminance of a centred square region of the camera image. */
export class CameraLightSensor implements Sensor {
  readonly id = 'light';
  readonly label = 'Light (camera)';
  private stream: MediaStream | null = null;
  private handle = 0;
  private stopped = false;
  private readonly canvas = document.createElement('canvas');

  constructor(
    private readonly video: HTMLVideoElement,
    /** ROI side as a fraction of the shorter video dimension. Keep in sync with the aim box. */
    readonly roiFraction = 0.2,
  ) {
    this.canvas.width = 32;
    this.canvas.height = 32;
  }

  async start(onSample: (t: number, level: number) => void): Promise<void> {
    this.stopped = false;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, frameRate: { ideal: 60 } },
    });
    const video = this.video as VideoWithRvfc;
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    const onFrame = (now: number, meta: FrameMeta) => {
      if (this.stopped) return;
      const side = Math.min(video.videoWidth, video.videoHeight) * this.roiFraction;
      const sx = (video.videoWidth - side) / 2;
      const sy = (video.videoHeight - side) / 2;
      ctx.drawImage(video, sx, sy, side, side, 0, 0, 32, 32);
      const px = ctx.getImageData(0, 0, 32, 32).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      onSample(meta.captureTime ?? meta.expectedDisplayTime ?? now, sum / (px.length / 4) / 255);
      this.handle = video.requestVideoFrameCallback(onFrame);
    };
    this.handle = video.requestVideoFrameCallback(onFrame);
  }

  stop(): void {
    this.stopped = true;
    (this.video as VideoWithRvfc).cancelVideoFrameCallback?.(this.handle);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
```

**Step 4: Commit**

```bash
git add receiver package-lock.json
git commit -m "feat(receiver): scaffold Vite app with channel registry and camera light sensor"
```

---

### Task 9: Receiver UI

**Files:**
- Create: `receiver/index.html`
- Create: `receiver/src/style.css`
- Create: `receiver/src/ui/graph.ts`
- Create: `receiver/src/ui/histogram.ts`
- Create: `receiver/src/main.ts`

**Step 1: HTML and CSS**

`receiver/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>FlashLink Receiver</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <main>
      <h1>FlashLink Receiver</h1>
      <div class="row">
        <label>Channel <select id="channel"></select></label>
        <button id="start">Start</button>
      </div>
      <div class="viewport">
        <video id="video" playsinline muted></video>
        <div id="aim" class="aim"></div>
      </div>
      <p>State: <span id="state" class="badge">IDLE</span> <span id="progress"></span></p>
      <canvas id="graph" width="600" height="120"></canvas>
      <pre id="message"></pre>
      <p id="error" class="error" hidden></p>
      <details>
        <summary>Calibration (edge intervals)</summary>
        <pre id="histogram"></pre>
      </details>
    </main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`receiver/src/style.css`:
```css
:root { font-family: system-ui, sans-serif; color-scheme: light dark; }
body { margin: 0; }
main { max-width: 640px; margin: 0 auto; padding: 16px; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
button { font-size: 1rem; padding: 8px 16px; }
.viewport { position: relative; margin: 12px 0; background: #000; }
video { display: block; width: 100%; height: auto; }
.aim { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
       border: 2px solid #ff3b30; box-sizing: border-box; pointer-events: none; }
canvas { width: 100%; height: 120px; background: #111; }
.badge { padding: 2px 8px; border-radius: 6px; background: #8884; font-weight: 600; }
.badge.LOCKED, .badge.READING { background: #ffcc00; color: #000; }
.badge.DONE { background: #34c759; color: #000; }
.badge.ERROR { background: #ff3b30; color: #fff; }
#message { font-size: 1.4rem; white-space: pre-wrap; word-break: break-word; }
.error { color: #ff3b30; }
```

**Step 2: Graph and histogram**

`receiver/src/ui/graph.ts`:
```ts
/** Scrolling plot of sensor level (blue) and detector threshold (red). */
export class Graph {
  private points: { t: number; v: number; thr: number | null }[] = [];

  constructor(private readonly canvas: HTMLCanvasElement, private readonly spanMs = 6000) {}

  push(t: number, v: number, thr: number | null): void {
    this.points.push({ t, v, thr });
    while (this.points.length && this.points[0].t < t - this.spanMs) this.points.shift();
    this.draw();
  }

  private draw(): void {
    const { width: w, height: h } = this.canvas;
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    if (!this.points.length) return;
    const t0 = this.points[this.points.length - 1].t - this.spanMs;
    const x = (t: number) => ((t - t0) / this.spanMs) * w;
    const y = (v: number) => h - v * h;

    ctx.strokeStyle = '#0a84ff';
    ctx.beginPath();
    this.points.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
    ctx.stroke();

    ctx.strokeStyle = '#ff3b30';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    let drawing = false;
    for (const p of this.points) {
      if (p.thr === null) { drawing = false; continue; }
      drawing ? ctx.lineTo(x(p.t), y(p.thr)) : ctx.moveTo(x(p.t), y(p.thr));
      drawing = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
```

`receiver/src/ui/histogram.ts`:
```ts
/** Text histogram of edge intervals; with the emitter in calibration mode, shows timing jitter. */
export class Histogram {
  private intervals: number[] = [];

  constructor(private readonly el: HTMLElement, private readonly bucketMs = 20, private readonly keep = 200) {}

  push(ms: number): void {
    this.intervals.push(ms);
    if (this.intervals.length > this.keep) this.intervals.shift();
    this.render();
  }

  private render(): void {
    const buckets = new Map<number, number>();
    for (const ms of this.intervals) {
      const b = Math.floor(ms / this.bucketMs);
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
    }
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const lines = [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([b, n]) => `${String(b * this.bucketMs).padStart(5)}–${String((b + 1) * this.bucketMs).padEnd(5)}ms ${'█'.repeat(n)}`);
    this.el.textContent = `n=${this.intervals.length}  median=${median.toFixed(0)}ms\n${lines.join('\n')}`;
  }
}
```

**Step 3: Main wiring**

`receiver/src/main.ts`:
```ts
import { Receiver, type ReceiverEvent } from '@flashlink/protocol';
import { channels } from './channels/registry';
import type { Sensor } from './channels/types';
import { Graph } from './ui/graph';
import { Histogram } from './ui/histogram';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = $<HTMLSelectElement>('channel');
const startBtn = $<HTMLButtonElement>('start');
const video = $<HTMLVideoElement>('video');
const aim = $<HTMLDivElement>('aim');
const stateEl = $<HTMLSpanElement>('state');
const progressEl = $<HTMLSpanElement>('progress');
const messageEl = $<HTMLPreElement>('message');
const errorEl = $<HTMLParagraphElement>('error');

const graph = new Graph($<HTMLCanvasElement>('graph'));
const histogram = new Histogram($<HTMLPreElement>('histogram'));

for (const c of channels) select.add(new Option(c.label, c.id));

let sensor: Sensor | null = null;

function setState(state: string): void {
  stateEl.textContent = state;
  stateEl.className = `badge ${state}`;
}

function showError(text: string | null): void {
  errorEl.hidden = text === null;
  errorEl.textContent = text ?? '';
}

function positionAim(): void {
  const side = 0.2 * Math.min(video.clientWidth, video.clientHeight);
  aim.style.width = aim.style.height = `${side}px`;
}
video.addEventListener('loadedmetadata', positionAim);
window.addEventListener('resize', positionAim);

function handle(e: ReceiverEvent): void {
  switch (e.type) {
    case 'state':
      setState(e.state);
      if (e.state === 'LOCKED') progressEl.textContent = '';
      break;
    case 'interval':
      histogram.push(e.ms);
      break;
    case 'progress':
      progressEl.textContent = `receiving ${e.received}/${e.length} bytes`;
      break;
    case 'message':
      messageEl.textContent = e.text;
      progressEl.textContent = '';
      break;
    case 'error':
      progressEl.textContent = '';
      if (e.reason === 'crc') messageEl.textContent = `${e.bestGuess}\n(corrupted, ask the sender to resend)`;
      else messageEl.textContent = '(signal lost, keep the light inside the red box)';
      break;
  }
}

async function start(): Promise<void> {
  showError(null);
  const def = channels.find((c) => c.id === select.value)!;
  const rx = new Receiver();
  sensor = def.create({ video });
  try {
    await sensor.start((t, level) => {
      graph.push(t, level, rx.threshold);
      rx.push(t, level).forEach(handle);
    });
    setState('HUNTING');
    startBtn.textContent = 'Stop';
  } catch (err) {
    sensor = null;
    if (!window.isSecureContext) showError('Camera needs HTTPS. Open the https:// URL that Vite printed.');
    else if (err instanceof DOMException && err.name === 'NotAllowedError')
      showError('Camera permission denied. Allow camera access for this site in your browser settings.');
    else showError(`Could not start the sensor: ${(err as Error).message}`);
  }
}

function stop(): void {
  sensor?.stop();
  sensor = null;
  setState('IDLE');
  startBtn.textContent = 'Start';
}

startBtn.addEventListener('click', () => (sensor ? stop() : void start()));
```

**Step 4: Typecheck and build**

Run: `npm run build -w receiver`
Expected: `tsc` passes, then Vite prints `✓ built in …`

**Step 5: Smoke-test on the laptop**

Run: `npm run receiver`
Open the printed `https://localhost:5173` link, accept the certificate warning, click **Start**, and allow the camera.
Expected: the video shows with a red aim box, and the blue line on the graph moves when you cover or uncover the webcam. Shine a phone torch into the box, and the red threshold line should appear.

**Step 6: Commit**

```bash
git add receiver
git commit -m "feat(receiver): add receiver UI with live graph, state badge and calibration histogram"
```

---

### Task 10: Emitter Expo app scaffold

**Files:**
- Create: `emitter/` (generated by create-expo-app)
- Modify: `emitter/package.json`

**Step 1: Generate the app without installing**

Run: `npx create-expo-app@latest emitter --template blank-typescript --no-install`
Expected: an `emitter/` folder containing `App.tsx`, `index.ts`, `app.json`, and `package.json`

If it created `emitter/.git`, delete that folder so the emitter stays part of the monorepo repo.

**Step 2: Name it and add dependencies**

In `emitter/package.json`, set `"name": "@flashlink/emitter"` and add `"@flashlink/protocol": "*"` to `dependencies`.

Run: `npm install`, then `cd emitter; npx expo install expo-camera; cd ..`
Expected: `expo-camera` is added at the version that matches the Expo SDK

**Step 3: Camera permission text**

In `emitter/app.json`, add to `expo.plugins`:
```json
["expo-camera", { "cameraPermission": "FlashLink uses the camera only to control the flashlight." }]
```

**Step 4: Verify that Metro resolves the workspace package**

Temporarily replace the body of `emitter/App.tsx` with one that renders `<Text>{utf8Length('héllo')}</Text>`, imported from `@flashlink/protocol`.
Run: `npm run start -w emitter`, scan the QR code with the iPhone camera, and open it in **Expo Go**.
Expected: the phone shows `6`.

If the phone can't reach the dev server (corporate Wi-Fi), use `npx expo start --tunnel` from `emitter/`.

**Step 5: Commit**

```bash
git add emitter package.json package-lock.json
git commit -m "feat(emitter): scaffold Expo app wired to protocol package"
```

---

### Task 11: Emitter light channel and UI

**Files:**
- Create: `emitter/src/channels/types.ts`
- Create: `emitter/src/channels/registry.ts`
- Create: `emitter/src/channels/light/LightChannel.tsx`
- Modify: `emitter/App.tsx`

**Step 1: Channel interfaces and registry**

`emitter/src/channels/types.ts`:
```ts
import type { ComponentType } from 'react';
import type { Level } from '@flashlink/protocol';

/** Drives one output. Timing comes from the shared runSchedule. */
export interface Transmitter {
  id: string;
  label: string;
  setLevel(level: Level): void;
}

export interface ChannelProps {
  /** Called with a ready transmitter, or null when it's unavailable/unmounted. */
  onReady(tx: Transmitter | null): void;
}

export interface ChannelDefinition {
  id: string;
  label: string;
  /** Mounted while the channel is selected; owns any hardware views/permissions. */
  Component: ComponentType<ChannelProps>;
}
```

`emitter/src/channels/registry.ts`:
```ts
import type { ChannelDefinition } from './types';
import { LightChannel } from './light/LightChannel';

// Add new channels (e.g. sound via speaker) here.
export const channels: ChannelDefinition[] = [
  { id: 'light', label: 'Light (torch)', Component: LightChannel },
];
```

**Step 2: Light channel**

`emitter/src/channels/light/LightChannel.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { ChannelProps } from '../types';

/** The torch only works while a CameraView is mounted, so we keep a tiny preview. */
export function LightChannel({ onReady }: ChannelProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const granted = permission?.granted ?? false;

  useEffect(() => {
    onReady(granted ? { id: 'light', label: 'Light (torch)', setLevel: (l) => setTorch(l === 1) } : null);
    return () => onReady(null);
  }, [granted, onReady]);

  if (!permission) return null;
  if (!granted) {
    return (
      <View style={styles.box}>
        <Text>Camera access is needed to control the flashlight.</Text>
        <Button title="Allow camera" onPress={requestPermission} />
      </View>
    );
  }
  return (
    <View style={styles.box}>
      <CameraView style={styles.preview} facing="back" enableTorch={torch} />
      <Text>Torch: {torch ? 'ON' : 'off'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  preview: { width: 48, height: 48, borderRadius: 8, overflow: 'hidden' },
});
```

**Step 3: App UI**

Replace `emitter/App.tsx`:
```tsx
import { useCallback, useRef, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  calibrationSignal, encodeFrame, manchesterEncode, MAX_PAYLOAD, PREAMBLE_BITS,
  runSchedule, utf8Length, type TimedLevels,
} from '@flashlink/protocol';
import { channels } from './src/channels/registry';
import type { Transmitter } from './src/channels/types';

const SPEEDS = [400, 200, 100];

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress(): void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={active ? styles.chipTextActive : undefined}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const [text, setText] = useState('Hello from FlashLink');
  const [bitMs, setBitMs] = useState(200);
  const [channelId, setChannelId] = useState(channels[0].id);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tx = useRef<Transmitter | null>(null);
  const abort = useRef<AbortController | null>(null);
  const onReady = useCallback((t: Transmitter | null) => { tx.current = t; }, []);

  const channel = channels.find((c) => c.id === channelId)!;
  const bytes = utf8Length(text);
  const tooLong = bytes > MAX_PAYLOAD;
  const seconds = ((PREAMBLE_BITS + 8 * (3 + bytes)) * bitMs) / 1000;
  const busy = progress !== null;

  async function play(signal: TimedLevels) {
    if (!tx.current) { setError('Channel not ready; grant permission first.'); return; }
    setError(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    setProgress(0);
    try {
      await runSchedule(signal, (l) => tx.current?.setLevel(l), {
        abort: ctrl.signal,
        onProgress: (done, total) => setProgress(done / total),
      });
    } finally {
      abort.current = null;
      setProgress(null);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>FlashLink Emitter</Text>

      <Text style={styles.label}>Channel</Text>
      <View style={styles.row}>
        {channels.map((c) => (
          <Chip key={c.id} label={c.label} active={c.id === channelId} onPress={() => !busy && setChannelId(c.id)} />
        ))}
      </View>
      <channel.Component onReady={onReady} />

      <Text style={styles.label}>Message</Text>
      <TextInput style={styles.input} value={text} onChangeText={setText} multiline editable={!busy} />
      <Text style={tooLong ? styles.error : styles.hint}>
        {bytes}/{MAX_PAYLOAD} bytes · ~{seconds.toFixed(0)} s at {bitMs} ms/bit
      </Text>

      <Text style={styles.label}>Speed (ms per bit)</Text>
      <View style={styles.row}>
        {SPEEDS.map((s) => (
          <Chip key={s} label={`${s}`} active={s === bitMs} onPress={() => !busy && setBitMs(s)} />
        ))}
      </View>

      {busy ? (
        <>
          <View style={styles.bar}><View style={[styles.fill, { width: `${(progress ?? 0) * 100}%` }]} /></View>
          <Pressable style={styles.button} onPress={() => abort.current?.abort()}>
            <Text style={styles.buttonText}>Stop</Text>
          </Pressable>
        </>
      ) : (
        <View style={styles.row}>
          <Pressable
            style={[styles.button, tooLong && styles.disabled]}
            disabled={tooLong}
            onPress={() => play(manchesterEncode(encodeFrame(text), bitMs))}
          >
            <Text style={styles.buttonText}>Send</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.secondary]} onPress={() => play(calibrationSignal(bitMs, 10_000))}>
            <Text style={styles.buttonText}>Calibrate (10 s)</Text>
          </Pressable>
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 20, gap: 8 },
  title: { fontSize: 24, fontWeight: '700', marginVertical: 12 },
  label: { fontWeight: '600', marginTop: 12 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: '#888' },
  chipActive: { backgroundColor: '#0a84ff', borderColor: '#0a84ff' },
  chipTextActive: { color: '#fff' },
  input: { borderWidth: 1, borderColor: '#888', borderRadius: 8, padding: 10, minHeight: 80, fontSize: 16 },
  hint: { color: '#888' },
  error: { color: '#ff3b30' },
  bar: { height: 8, backgroundColor: '#8884', borderRadius: 4, overflow: 'hidden', marginTop: 16 },
  fill: { height: '100%', backgroundColor: '#0a84ff' },
  button: { backgroundColor: '#0a84ff', paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10, marginTop: 16 },
  secondary: { backgroundColor: '#5e5ce6' },
  disabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontWeight: '600' },
});
```

**Step 4: Typecheck**

Run: `cd emitter; npx tsc --noEmit; cd ..`
Expected: exit 0. If `TextEncoder` is reported missing, add `"lib": ["DOM", "ESNext"]` to `compilerOptions` in `emitter/tsconfig.json`.

**Step 5: Try it on the iPhone**

Run: `npm run emitter`, then open the app in Expo Go.
Expected: after you grant camera permission, a tiny preview appears. **Calibrate** blinks the torch steadily and **Stop** turns it off.

**Step 6: Commit**

```bash
git add emitter
git commit -m "feat(emitter): add torch light channel, message UI, speed picker and calibration"
```

---

### Task 12: End-to-end device test and README

**Files:**
- Create: `README.md`

**Step 1: Run the device checklist (manual)**

1. Run `npm run receiver` on the laptop. On the receiving phone, open `https://<laptop-LAN-IP>:5173` (Vite prints it) and accept the certificate warning.
2. Point the receiver at the iPhone torch from 10–30 cm, with the torch inside the red box.
3. **Calibrate at 200 ms.** In the receiver's histogram, the intervals should cluster around 200 ms. Note the spread.
4. **Send** `Hello` at 400, 200 and 100 ms. Record which speeds decode reliably (3 out of 3 attempts).
5. Send `héllo 👋` at the fastest reliable speed.
6. Cover the torch mid-message. The receiver should show "signal lost".

If the receiver never locks, check the graph:
- **The blue line is flat:** the room is too bright or the box is off the torch.
- **The blue line drifts slowly:** auto-exposure is fighting the torch. Move closer.

**Step 2: README**

`README.md`:
````markdown
# FlashLink

Send text from an iPhone's flashlight to any camera, with pluggable transfer channels (light now, sound next).

- `protocol/`: framing, Manchester coding, decoder pipeline, simulator (`npm test`)
- `emitter/`: Expo Go app (iPhone). `npm run emitter`, then scan the QR code with Expo Go
- `receiver/`: web app (any camera). `npm run receiver`, then open the https URL and accept the certificate

## Adding a channel

1. Emitter: implement `Transmitter.setLevel` in `emitter/src/channels/<name>/`, register it in `registry.ts`.
2. Receiver: implement `Sensor` (emit `(timestamp, level 0–1)`) in `receiver/src/channels/<name>/`, register it.

Framing, modulation and the scheduler are shared, so nothing in `protocol/` changes.

Design: `docs/plans/2026-10-23-flashlink-design.md`
````

Fill in the reliable speeds from step 1 as a "Measured" line in the README.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README and device test results"
```
