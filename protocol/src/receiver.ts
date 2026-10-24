import { FrameDecoder } from './framing/frame';
import { ManchesterDecoder, type ManchesterDecoderOptions } from './modulation/manchester/decode';
import { DutyCorrector, type DutyCorrectorOptions } from './signal/dutyCorrector';
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
  duty?: DutyCorrectorOptions;
}

/** Sensor samples in, decoded messages out. Channel-agnostic: any sensor producing levels works. */
export class Receiver {
  state: ReceiverState = 'HUNTING';
  private readonly edges: EdgeDetector;
  private readonly demod: ManchesterDecoder;
  private readonly duty: DutyCorrector;
  private readonly frame = new FrameDecoder();
  private lastEdgeT: number | null = null;

  constructor(opts: ReceiverOptions = {}) {
    this.edges = new EdgeDetector(opts.edge);
    this.demod = new ManchesterDecoder(opts.demod);
    this.duty = new DutyCorrector(opts.duty);
  }

  get threshold(): number | null {
    return this.edges.threshold;
  }

  /** Measured delay of the transmitter's off→on switching (ms), removed before decoding. */
  get skewMs(): number {
    return this.duty.skewMs;
  }

  push(t: number, level: number): ReceiverEvent[] {
    const events: ReceiverEvent[] = [];
    const raw = this.edges.push(t, level);
    if (!raw) {
      if (this.demod.checkTimeout(t)) this.onLost(events);
      return events;
    }

    if (this.lastEdgeT !== null) events.push({ type: 'interval', ms: raw.t - this.lastEdgeT });
    this.lastEdgeT = raw.t;
    const edge = this.duty.push(raw);

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
    this.lastEdgeT = null;
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
    this.lastEdgeT = null;
    this.setState(state, events);
  }

  private setState(state: ReceiverState, events: ReceiverEvent[]): void {
    if (state === this.state) return;
    this.state = state;
    events.push({ type: 'state', state });
  }
}
