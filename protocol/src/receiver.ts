import type { Bit } from './framing/bits';
import { FrameDecoder, type LaneHeader } from './framing/frame';
import { type DemodState, ManchesterDecoder, type ManchesterDecoderOptions } from './modulation/manchester/decode';
import { PulseDecoder, type PulseDecoderOptions } from './modulation/pulse/decode';
import { DutyCorrector, type DutyCorrectorOptions } from './signal/dutyCorrector';
import { type Edge, EdgeDetector, type EdgeDetectorOptions } from './signal/edgeDetector';

/** There is no stopped state: after a chunk or an error the receiver goes back to hunting. */
export type ReceiverState = 'HUNTING' | 'LOCKED' | 'READING' | 'DONE';

export type Coding = 'pulse' | 'manchester';

export type ReceiverEvent =
  | { type: 'state'; state: ReceiverState }
  | { type: 'interval'; ms: number }
  /** `bytes` is the chunk so far: streamed for display, not yet checked by the CRC. */
  | { type: 'progress'; header: LaneHeader; received: number; length: number; bytes: Uint8Array }
  /** A CRC-checked lane chunk; a single-lane chunk is a whole message (see `decodePayload`). */
  | { type: 'chunk'; header: LaneHeader; bytes: Uint8Array; coding: Coding }
  | { type: 'error'; reason: 'crc' | 'lost' };

export interface ReceiverOptions {
  edge?: EdgeDetectorOptions;
  /** Manchester demodulator options. */
  demod?: ManchesterDecoderOptions;
  pulse?: PulseDecoderOptions;
  duty?: DutyCorrectorOptions;
}

interface Demodulator {
  state: DemodState;
  pushEdge(edge: Edge): Bit[];
  checkTimeout(now: number): boolean;
  reset(): void;
}

/** One demodulator with its own frame decoder. */
interface Path {
  coding: Coding;
  demod: Demodulator;
  frame: FrameDecoder;
}

/**
 * Sensor samples in, lane chunks out, for one light. Channel-agnostic: any sensor
 * producing levels works. Edges feed a Manchester and a pulse-length demodulator in
 * parallel, each with its own frame decoder; the first to deliver a CRC-checked frame
 * wins and both start over. The state reflects whichever path is furthest along.
 *
 * The Manchester path gets duty-corrected edges (Manchester is on half the time, which
 * is what the corrector assumes); the pulse path gets raw edges and measures the
 * turn-on skew in its own preamble.
 */
export class Receiver {
  state: ReceiverState = 'HUNTING';
  private readonly edges: EdgeDetector;
  private readonly duty: DutyCorrector;
  private readonly paths: Path[];
  private lastEdgeT: number | null = null;

  constructor(opts: ReceiverOptions = {}) {
    this.edges = new EdgeDetector(opts.edge);
    this.duty = new DutyCorrector(opts.duty);
    this.paths = [
      { coding: 'manchester', demod: new ManchesterDecoder(opts.demod), frame: new FrameDecoder() },
      { coding: 'pulse', demod: new PulseDecoder(opts.pulse), frame: new FrameDecoder() },
    ];
  }

  get threshold(): number | null {
    return this.edges.threshold;
  }

  /** Measured delay of the transmitter's off→on switching (ms), removed before Manchester decoding. */
  get skewMs(): number {
    return this.duty.skewMs;
  }

  push(t: number, level: number): ReceiverEvent[] {
    const events: ReceiverEvent[] = [];
    const raw = this.edges.push(t, level);
    if (!raw) {
      for (const p of this.paths) {
        if (p.demod.checkTimeout(t)) {
          this.lastEdgeT = null;
          this.onLost(p, events);
        }
      }
      this.updateState(events);
      return events;
    }

    if (this.lastEdgeT !== null) events.push({ type: 'interval', ms: raw.t - this.lastEdgeT });
    this.lastEdgeT = raw.t;
    const corrected = this.duty.push(raw);

    for (const p of this.paths) {
      if (this.pushPath(p, p.coding === 'pulse' ? raw : corrected, events)) return events;
    }
    this.updateState(events);
    return events;
  }

  /** Returns true once a chunk is delivered (everything has been reset). */
  private pushPath(p: Path, edge: Edge, events: ReceiverEvent[]): boolean {
    const wasLocked = p.demod.state === 'LOCKED';
    const bits = p.demod.pushEdge(edge);
    if (wasLocked && p.demod.state === 'HUNTING') {
      this.onLost(p, events);
      return false;
    }
    if (bits.length > 0) this.updateState(events); // LOCKED before any READING it leads to

    for (const bit of bits) {
      const ev = p.frame.push(bit);
      if (!ev) continue;
      if (ev.type === 'header') {
        this.updateState(events);
        events.push({ type: 'progress', header: ev.header, received: 0, length: ev.length, bytes: new Uint8Array() });
      } else if (ev.type === 'progress') {
        events.push({ type: 'progress', header: ev.header, received: ev.bytes.length, length: ev.length, bytes: ev.bytes });
      } else if (ev.type === 'done') {
        events.push({ type: 'chunk', header: ev.header, bytes: ev.bytes, coding: p.coding });
        for (const q of this.paths) {
          q.demod.reset();
          q.frame.reset();
        }
        this.lastEdgeT = null;
        this.setState('DONE', events);
        return true;
      } else {
        events.push({ type: 'error', reason: 'crc' });
        p.frame.reset();
        // Start over, but leave a path that is reading a frame of its own alone.
        for (const q of this.paths) {
          if (!q.frame.reading) q.demod.reset();
        }
        this.updateState(events, true);
        return false;
      }
    }
    return false;
  }

  private onLost(p: Path, events: ReceiverEvent[]): void {
    const wasReading = p.frame.reading;
    p.frame.reset();
    if (wasReading) events.push({ type: 'error', reason: 'lost' });
    this.updateState(events, wasReading);
  }

  /**
   * Sets the state of the furthest path. DONE is kept until a path locks again, except
   * after an error (`failed`), which always shows the drop back.
   */
  private updateState(events: ReceiverEvent[], failed = false): void {
    const next: ReceiverState = this.paths.some((p) => p.frame.reading) ? 'READING'
      : this.paths.some((p) => p.demod.state === 'LOCKED') ? 'LOCKED'
      : 'HUNTING';
    if (next === 'HUNTING' && this.state === 'DONE' && !failed) return;
    this.setState(next, events);
  }

  private setState(state: ReceiverState, events: ReceiverEvent[]): void {
    if (state === this.state) return;
    this.state = state;
    events.push({ type: 'state', state });
  }
}
