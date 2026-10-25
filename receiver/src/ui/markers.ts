import type { ReceiverState } from '@flashlink/protocol';
import type { SensorSource } from '../channels/types';

/**
 * A numbered ring on the video over every light being tracked. Display only: rings are
 * reused per source id and moved with `transform`, at most once per animation frame.
 * The number is the light's lane (1-based, as the emitter counts its bulbs) once a frame
 * header has been read from it, otherwise its source id in muted form.
 */
export class Markers {
  private readonly els = new Map<number, HTMLElement>();
  private w = 0;
  private h = 0;
  private frame = 0;
  private pending: { sources: SensorSource[]; states: Map<number, ReceiverState>; lanes: Map<number, number> } | null = null;

  constructor(private readonly container: HTMLElement) {
    new ResizeObserver(() => {
      this.w = container.clientWidth;
      this.h = container.clientHeight;
    }).observe(container);
  }

  update(sources: SensorSource[], states: Map<number, ReceiverState>, lanes: Map<number, number>): void {
    this.pending = { sources, states, lanes };
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw());
  }

  clear(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pending = null;
    for (const el of this.els.values()) el.remove();
    this.els.clear();
  }

  private draw(): void {
    this.frame = 0;
    const p = this.pending;
    if (!p) return;
    const seen = new Set<number>();
    for (const s of p.sources) {
      seen.add(s.id);
      let el = this.els.get(s.id);
      if (!el) {
        el = document.createElement('span');
        el.className = 'marker';
        this.container.append(el);
        this.els.set(s.id, el);
      }
      const lane = p.lanes.get(s.id);
      const label = lane === undefined ? String(s.id) : String(lane + 1);
      if (el.textContent !== label) el.textContent = label;
      el.toggleAttribute('data-lane', lane !== undefined);
      el.dataset.state = p.states.get(s.id) ?? 'HUNTING';
      el.style.transform = `translate3d(${(s.cx * this.w).toFixed(1)}px, ${(s.cy * this.h).toFixed(1)}px, 0)`;
    }
    for (const [id, el] of this.els) {
      if (seen.has(id)) continue;
      el.remove();
      this.els.delete(id);
    }
  }
}
