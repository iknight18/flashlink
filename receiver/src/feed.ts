export type FeedStatus = 'live' | 'verified' | 'failed';

export interface FeedRow {
  id: number;
  msgId: number;
  text: string;
  status: FeedStatus;
  /** Times a verified message was received (a looping emitter repeats it). */
  count: number;
  /** A verified row whose next repeat is streaming in now. */
  repeating: boolean;
  reason?: 'garbled' | 'lost';
  /** When the row last changed meaningfully (created, verified, repeated), ms since epoch. */
  at: number;
}

/** Called for every row that changed; `removed` when it left the feed. */
export type FeedListener = (row: FeedRow, removed: boolean) => void;

/**
 * The message list, driven by MultiReceiver events and free of DOM so it can be tested.
 *
 * - `progress` streams into one live row; a pass that is a prefix of the last verified
 *   message under the same msgId is a repeat and only marks that row as repeating.
 * - `message` verifies the live row, or counts a repeat (same msgId and text) on the last
 *   verified row.
 * - An `error` is per light: it fails the attempt only once no other light is still
 *   reading, since the other lanes (or the next pass) may still complete the message.
 */
export class Feed {
  readonly rows: FeedRow[] = [];
  live: FeedRow | null = null;
  /** An error arrived while other lights were reading; fail once they stop. */
  private pending: 'garbled' | 'lost' | null = null;
  private nextId = 1;

  constructor(
    private readonly onRow: FeedListener = () => {},
    private readonly limit = 50,
  ) {}

  get verifiedCount(): number {
    return this.rows.filter((r) => r.status === 'verified').length;
  }

  private lastVerified(): FeedRow | null {
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i].status === 'verified') return this.rows[i];
    return null;
  }

  progress(msgId: number, text: string): void {
    const last = this.lastVerified();
    if (!this.live && last && last.msgId === msgId && last.text.startsWith(text)) {
      this.setRepeating(last, true);
      return;
    }
    if (last) this.setRepeating(last, false);
    if (this.live && this.live.msgId !== msgId) this.fail('lost');
    if (!this.live) this.live = this.add(msgId, 'live');
    if (this.live.text !== text) {
      this.live.text = text;
      this.onRow(this.live, false);
    }
  }

  message(msgId: number, text: string): void {
    this.pending = null;
    const last = this.lastVerified();
    if (last && last.msgId === msgId && last.text === text) {
      // A repeat; a live row of this pass (it streamed garbage that the CRC rejected) goes.
      if (this.live?.msgId === msgId) {
        this.remove(this.live.id);
        this.live = null;
      }
      last.count++;
      last.repeating = false;
      last.at = Date.now();
      this.onRow(last, false);
      return;
    }
    if (last) this.setRepeating(last, false);
    if (this.live && this.live.msgId !== msgId) this.fail('lost');
    const row = this.live ?? this.add(msgId, 'verified');
    this.live = null;
    Object.assign(row, { status: 'verified', text, count: 1, at: Date.now() });
    this.onRow(row, false);
  }

  /**
   * One light lost its frame or failed the CRC. Returns true when this ended the
   * attempt (nothing else was reading).
   */
  error(reason: 'crc' | 'lost', anyReading: boolean): boolean {
    const r = reason === 'crc' ? 'garbled' : 'lost';
    if (!this.live && !this.lastVerified()?.repeating) return false;
    if (anyReading) {
      this.pending = r;
      return false;
    }
    return this.endAttempt(r);
  }

  /** Source states changed; a pending error fails the attempt once nothing is reading. */
  sources(anyReading: boolean): boolean {
    if (anyReading || !this.pending) return false;
    return this.endAttempt(this.pending);
  }

  remove(id: number): void {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return;
    const [row] = this.rows.splice(i, 1);
    if (row === this.live) this.live = null;
    this.onRow(row, true);
  }

  /** Drops everything streaming (e.g. the receiver stopped); verified rows stay. */
  reset(): void {
    if (this.live) this.remove(this.live.id);
    const last = this.lastVerified();
    if (last) this.setRepeating(last, false);
    this.pending = null;
  }

  private endAttempt(reason: 'garbled' | 'lost'): boolean {
    const last = this.lastVerified();
    if (last) this.setRepeating(last, false);
    if (this.live) this.fail(reason);
    this.pending = null;
    return true;
  }

  private fail(reason: 'garbled' | 'lost'): void {
    const row = this.live!;
    this.live = null;
    row.status = 'failed';
    row.reason = reason;
    this.onRow(row, false);
  }

  private setRepeating(row: FeedRow, on: boolean): void {
    if (row.repeating === on) return;
    row.repeating = on;
    this.onRow(row, false);
  }

  private add(msgId: number, status: FeedStatus): FeedRow {
    const row: FeedRow = { id: this.nextId++, msgId, text: '', status, count: 0, repeating: false, at: Date.now() };
    this.rows.push(row);
    while (this.rows.length > this.limit) this.remove(this.rows[0].id);
    return row;
  }
}
