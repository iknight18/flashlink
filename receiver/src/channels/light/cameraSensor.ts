import type { Region, Sensor } from '../types';
import { BlinkTracker } from './blinkTracker';

type FrameMeta = { captureTime?: number; expectedDisplayTime: number };
type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback(cb: (now: number, meta: FrameMeta) => void): number;
  cancelVideoFrameCallback(handle: number): void;
};

/** Grid width the frame is downscaled to before tracking; height follows the aspect ratio. */
const GRID_WIDTH = 48;

/**
 * Target manual exposure, in the Image Capture spec's 100 µs units (8 ms). Webcams in
 * dim rooms stretch their exposure and drop to ~15 fps; the torch is bright enough
 * that a short exposure keeps the camera at its full frame rate.
 */
const SHORT_EXPOSURE = 80;

type ExposureCapabilities = MediaTrackCapabilities & {
  exposureMode?: string[];
  exposureTime?: { min: number; max: number };
};

/** Best effort: switch to a short manual exposure where the camera allows it. */
async function shortenExposure(track: MediaStreamTrack): Promise<string> {
  const caps = track.getCapabilities?.() as ExposureCapabilities | undefined;
  if (!caps?.exposureMode?.includes('manual') || !caps.exposureTime) return 'not supported';
  const exposureTime = Math.min(caps.exposureTime.max, Math.max(caps.exposureTime.min, SHORT_EXPOSURE));
  try {
    await track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime } as MediaTrackConstraintSet] });
    return `manual ${exposureTime}`;
  } catch (err) {
    return `rejected: ${(err as Error).message}`;
  }
}

/** Level of the blinking light, found anywhere in the frame by BlinkTracker. */
export class CameraLightSensor implements Sensor {
  readonly id = 'light';
  readonly label = 'Light (camera)';
  private stream: MediaStream | null = null;
  private handle = 0;
  private stopped = false;
  private tracker: BlinkTracker | null = null;
  private exposure = 'unknown';
  private readonly canvas = document.createElement('canvas');

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onRegion?: (region: Region) => void,
  ) {}

  async start(onSample: (t: number, level: number) => void): Promise<void> {
    this.stopped = false;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // Small frames are plenty for a 48-pixel tracking grid, and let many cameras run faster.
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
    });
    this.exposure = await shortenExposure(this.stream.getVideoTracks()[0]);
    const video = this.video as VideoWithRvfc;
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    let luma = new Float32Array(0);
    let lastRegion = '';
    const onFrame = (now: number, meta: FrameMeta) => {
      if (this.stopped) return;
      const gw = GRID_WIDTH;
      const gh = Math.max(1, Math.round((GRID_WIDTH * video.videoHeight) / video.videoWidth));
      if (!this.tracker || this.tracker.height !== gh) {
        // First frame, or the camera rotated: start tracking afresh at the new aspect ratio.
        this.tracker = new BlinkTracker(gw, gh);
        this.canvas.width = gw;
        this.canvas.height = gh;
        luma = new Float32Array(gw * gh);
      }
      ctx.drawImage(video, 0, 0, gw, gh);
      const px = ctx.getImageData(0, 0, gw, gh).data;
      for (let i = 0; i < luma.length; i++) {
        luma[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
      }
      const t = meta.captureTime ?? meta.expectedDisplayTime ?? now;
      const level = this.tracker.push(t, luma);
      const region = this.tracker.region;
      const key = `${region.x},${region.y},${region.w},${region.h}`;
      if (key !== lastRegion) {
        lastRegion = key;
        this.onRegion?.(region);
      }
      onSample(t, level);
      this.handle = video.requestVideoFrameCallback(onFrame);
    };
    this.handle = video.requestVideoFrameCallback(onFrame);
  }

  describe(): Record<string, unknown> {
    const track = this.stream?.getVideoTracks()[0];
    const s = track?.getSettings();
    return {
      label: track?.label,
      width: s?.width,
      height: s?.height,
      frameRate: s?.frameRate,
      exposure: this.exposure,
    };
  }

  stop(): void {
    this.stopped = true;
    (this.video as VideoWithRvfc).cancelVideoFrameCallback?.(this.handle);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.tracker = null;
    this.video.srcObject = null;
  }
}
