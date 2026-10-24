import { FrameDecoder } from './framing/frame';
import { decodePayload } from './framing/textCodec';
import { ManchesterDecoder, type ManchesterDecoderOptions } from './modulation/manchester/decode';
import { DutyCorrector, type DutyCorrectorOptions } from './signal/dutyCorrector';
import { EdgeDetector, type EdgeDetectorOptions } from './signal/edgeDetector';

/** There is no stopped state: after a message or an error the receiver goes back to hunting. */
export type ReceiverState = 'HUNTING' | 'LOCKED' | 'READING' | 'DONE';

export type ReceiverEvent =
  | { type: 'state'; state: ReceiverState }
  | { type: 'interval'; ms: number }
  /** `text` is the payload so far: streamed for display, not yet checked by the CRC. */
  | { type: 'progress'; received: number; length: number; text: string }
  | { type: 'message'; text: string }
  | { type: 'error'; reason: 'crc' }
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
        events.push({ type: 'progress', received: 0, length: ev.length, text: '' });
      } else if (ev.type === 'progress') {
        const text = decodePayload(ev.bytes, ev.header.compressed, true);
        events.push({ type: 'progress', received: ev.bytes.length, length: ev.length, text });
      } else if (ev.type === 'done') {
        let text: string;
        try {
          text = decodePayload(ev.bytes, ev.header.compressed);
        } catch {
          // Passed the CRC by chance but is not a valid payload.
          events.push({ type: 'error', reason: 'crc' });
          this.finish('HUNTING', events);
          break;
        }
        events.push({ type: 'message', text });
        this.finish('DONE', events);
        break;
      } else {
        events.push({ type: 'error', reason: 'crc' });
        this.finish('HUNTING', events);
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
      this.setState('HUNTING', events);
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
