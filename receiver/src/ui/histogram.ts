import { fitCanvas, theme } from './theme';

/** Bar chart of edge intervals; with the emitter in calibration mode, it shows timing jitter. */
export class Histogram {
  private intervals: number[] = [];

  constructor(private readonly canvas: HTMLCanvasElement, private readonly bucketMs = 20, private readonly keep = 200) {
    new ResizeObserver(() => this.render()).observe(canvas);
  }

  push(ms: number): void {
    this.intervals.push(ms);
    if (this.intervals.length > this.keep) this.intervals.shift();
    this.render();
  }

  private render(): void {
    if (!this.canvas.clientWidth) return; // collapsed <details>
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.font = `11px ${theme.mono}`;

    if (!this.intervals.length) {
      ctx.fillStyle = theme.faint;
      ctx.fillText('no edges yet', 0, h / 2);
      return;
    }

    const lo = Math.floor(Math.min(...this.intervals) / this.bucketMs);
    const hi = Math.floor(Math.max(...this.intervals) / this.bucketMs);
    const counts = new Array(hi - lo + 1).fill(0);
    for (const ms of this.intervals) counts[Math.floor(ms / this.bucketMs) - lo]++;
    const peak = Math.max(...counts);

    const axis = 16;
    const slot = w / counts.length;
    const barW = Math.max(2, slot - 3);
    ctx.fillStyle = theme.accent;
    counts.forEach((n, i) => {
      const bh = (n / peak) * (h - axis - 4);
      ctx.beginPath();
      ctx.roundRect(i * slot, h - axis - bh, barW, bh, 2);
      ctx.fill();
    });

    const sorted = [...this.intervals].sort((a, b) => a - b);
    ctx.fillStyle = theme.muted;
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${lo * this.bucketMs} ms`, 0, h);
    const right = `${(hi + 1) * this.bucketMs} ms`;
    ctx.fillText(right, w - ctx.measureText(right).width, h);
    const mid = `median ${Math.round(sorted[sorted.length >> 1])} ms`;
    ctx.fillText(mid, (w - ctx.measureText(mid).width) / 2, h);
  }
}
