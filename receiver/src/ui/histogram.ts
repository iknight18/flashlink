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
