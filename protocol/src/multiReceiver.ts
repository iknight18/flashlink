import { type LivePartial, MessageAssembler } from './framing/lanes';
import { Receiver, type ReceiverEvent, type ReceiverOptions, type ReceiverState } from './receiver';

export type MultiEvent =
  /** The tracked sources and their receiver states; emitted only when either changes. */
  | { type: 'sources'; sources: { id: number; state: ReceiverState }[] }
  /** Text decodable so far (unverified live bytes included, for display); only grows within a message. */
  | { type: 'progress'; msgId: number; lanes: number; lanesDone: number; text: string }
  /** Every lane arrived with a valid CRC. Repeats of the same message are reported again. */
  | { type: 'message'; msgId: number; text: string; lanes: number }
  | { type: 'error'; sourceId: number; reason: 'crc' | 'lost' };

export interface MultiReceiverOptions extends ReceiverOptions {
  /** A source unseen for this long is dropped with its decoder. Default 3000 ms. */
  dropAfterMs?: number;
}

interface Source {
  rx: Receiver;
  lastSeen: number;
  /** Frame being read by this source, if any. */
  live: LivePartial | null;
}

/**
 * Decodes messages split across several lights. Keeps one `Receiver` per source id
 * (the light finder's blob id) and assembles their lane chunks by header, so which
 * light carries which lane, and the order sources are listed in, don't matter.
 */
export class MultiReceiver {
  private readonly sources = new Map<number, Source>();
  private readonly assembler = new MessageAssembler();
  private readonly opts: MultiReceiverOptions;
  private readonly dropAfterMs: number;
  private lastSources = '';
  private lastProgress: { msgId: number; lanesDone: number; text: string } | null = null;

  constructor(opts: MultiReceiverOptions = {}) {
    this.opts = opts;
    this.dropAfterMs = opts.dropAfterMs ?? 3000;
  }

  /** The receiver of one source, for diagnostics (threshold, skew, state). */
  receiver(id: number): Receiver | undefined {
    return this.sources.get(id)?.rx;
  }

  /** One camera frame: the level of every source seen in it. */
  push(t: number, sources: { id: number; level: number }[]): MultiEvent[] {
    const events: MultiEvent[] = [];
    for (const { id, level } of sources) {
      let src = this.sources.get(id);
      if (!src) {
        src = { rx: new Receiver(this.opts), lastSeen: t, live: null };
        this.sources.set(id, src);
      }
      src.lastSeen = t;
      for (const ev of src.rx.push(t, level)) this.handle(id, src, ev, events);
    }
    for (const [id, src] of this.sources) {
      if (t - src.lastSeen > this.dropAfterMs) this.sources.delete(id);
    }
    this.reportSources(events);
    return events;
  }

  private handle(id: number, src: Source, ev: ReceiverEvent, events: MultiEvent[]): void {
    switch (ev.type) {
      case 'progress':
        src.live = { header: ev.header, bytes: ev.bytes };
        this.reportProgress(ev.header.msgId, ev.header.lanes, events);
        break;
      case 'chunk': {
        src.live = null;
        const { text, complete } = this.assembler.add(ev.header, ev.bytes);
        if (complete) {
          this.lastProgress = null;
          events.push({ type: 'message', msgId: ev.header.msgId, text, lanes: ev.header.lanes });
        } else {
          this.reportProgress(ev.header.msgId, ev.header.lanes, events);
        }
        break;
      }
      case 'error':
        src.live = null;
        events.push({ type: 'error', sourceId: id, reason: ev.reason });
        break;
    }
  }

  /**
   * Emits progress when the text grows or another lane completes. Text that is a prefix
   * of what was shown (a live lane was lost) keeps the longer text, so it never shrinks.
   */
  private reportProgress(msgId: number, lanes: number, events: MultiEvent[]): void {
    const live = [...this.sources.values()].flatMap((s) => (s.live ? [s.live] : []));
    let text = this.assembler.preview(msgId, live);
    const lanesDone = this.assembler.lanesDone(msgId);
    const prev = this.lastProgress?.msgId === msgId ? this.lastProgress : null;
    if (prev && prev.text.startsWith(text)) text = prev.text;
    if (prev && prev.text === text && prev.lanesDone === lanesDone) return;
    this.lastProgress = { msgId, lanesDone, text };
    events.push({ type: 'progress', msgId, lanes, lanesDone, text });
  }

  private reportSources(events: MultiEvent[]): void {
    const sources = [...this.sources.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, s]) => ({ id, state: s.rx.state }));
    const key = JSON.stringify(sources);
    if (key === this.lastSources) return;
    this.lastSources = key;
    events.push({ type: 'sources', sources });
  }
}
