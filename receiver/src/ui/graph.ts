import { fitCanvas, theme } from './theme';

/** Scrolling plot of the sensor level and the detector threshold. */
export class Graph {
  private points: { t: number; v: number; thr: number | null }[] = [];
  private frame = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly spanMs = 6000) {
    this.draw();
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  push(t: number, v: number, thr: number | null): void {
    this.points.push({ t, v, thr });
    while (this.points.length && this.points[0].t < t - this.spanMs) this.points.shift();
    // Coalesce camera frames into at most one redraw per animation frame.
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw());
  }

  clear(): void {
    this.points = [];
    this.draw();
  }

  private draw(): void {
    this.frame = 0;
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(0, Math.round(h * f) + 0.5);
      ctx.lineTo(w, Math.round(h * f) + 0.5);
      ctx.stroke();
    }

    if (!this.points.length) {
      ctx.fillStyle = theme.faint;
      ctx.font = `12px ${theme.mono}`;
      ctx.fillText('no signal', 12, h / 2 + 4);
      return;
    }

    const pad = 8;
    const t0 = this.points[this.points.length - 1].t - this.spanMs;
    const x = (t: number) => ((t - t0) / this.spanMs) * w;
    const y = (v: number) => pad + (1 - Math.min(1, Math.max(0, v))) * (h - pad * 2);

    ctx.beginPath();
    this.points.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.lineTo(x(this.points[this.points.length - 1].t), h);
    ctx.lineTo(x(this.points[0].t), h);
    ctx.closePath();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = theme.accent;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
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
