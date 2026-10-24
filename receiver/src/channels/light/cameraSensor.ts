import type { Sensor } from '../types';
import { lightLevel } from './frameLevel';

type FrameMeta = { captureTime?: number; expectedDisplayTime: number };
type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback(cb: (now: number, meta: FrameMeta) => void): number;
  cancelVideoFrameCallback(handle: number): void;
};

/** Grid width the frame is downscaled to; height follows the aspect ratio. */
const GRID_WIDTH = 96;

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

const CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  // Small frames are plenty for a 96-pixel-wide grid, and let many cameras run faster.
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
};

/** Opens the camera, retrying once: Windows webcams are often briefly busy right after a stop. */
async function openCamera(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotReadableError')) throw err;
    await new Promise((r) => setTimeout(r, 800));
    return navigator.mediaDevices.getUserMedia(CONSTRAINTS);
  }
}

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

/** Level of the light anywhere in the camera frame (see lightLevel); nothing is tracked. */
export class CameraLightSensor implements Sensor {
  readonly id = 'light';
  readonly label = 'Light (camera)';
  private stream: MediaStream | null = null;
  private handle = 0;
  private stopped = false;
  private exposure = 'unknown';
  private readonly canvas = document.createElement('canvas');

  constructor(private readonly video: HTMLVideoElement) {}

  async start(onSample: (t: number, level: number) => void): Promise<void> {
    this.stopped = false;
    this.stream = await openCamera();
    this.exposure = await shortenExposure(this.stream.getVideoTracks()[0]);
    const video = this.video as VideoWithRvfc;
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    let luma = new Float32Array(0);
    const onFrame = (now: number, meta: FrameMeta) => {
      if (this.stopped) return;
      // Schedule the next frame first, so an error in this one can't stop the loop.
      this.handle = video.requestVideoFrameCallback(onFrame);
      try {
        readFrame(now, meta);
      } catch (err) {
        queueMicrotask(() => {
          throw err; // surfaces in window 'error' handlers and the console
        });
      }
    };
    const readFrame = (now: number, meta: FrameMeta) => {
      const gw = GRID_WIDTH;
      const gh = Math.max(1, Math.round((GRID_WIDTH * video.videoHeight) / video.videoWidth));
      if (luma.length !== gw * gh) {
        // First frame, or the camera rotated.
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
      onSample(t, lightLevel(luma));
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
    this.video.srcObject = null;
  }
}
