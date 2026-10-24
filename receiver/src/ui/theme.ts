/** Canvas colours read from the CSS custom properties, refreshed when the colour scheme changes. */
export const theme = { accent: '', muted: '', faint: '', line: '', mono: '' };

function read(): void {
  const css = getComputedStyle(document.documentElement);
  theme.accent = css.getPropertyValue('--accent').trim();
  theme.muted = css.getPropertyValue('--muted').trim();
  theme.faint = css.getPropertyValue('--faint').trim();
  theme.line = css.getPropertyValue('--line').trim();
  theme.mono = css.getPropertyValue('--mono').trim();
}

read();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', read);

/** Sizes a canvas's backing store to its CSS box × devicePixelRatio; returns a context in CSS pixels. */
export function fitCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
