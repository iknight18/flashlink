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
