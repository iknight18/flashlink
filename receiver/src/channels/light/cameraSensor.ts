import type { Sensor } from '../types';

type FrameMeta = { captureTime?: number; expectedDisplayTime: number };
type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback(cb: (now: number, meta: FrameMeta) => void): number;
  cancelVideoFrameCallback(handle: number): void;
};

/** Average luminance of a centred square region of the camera image. */
export class CameraLightSensor implements Sensor {
  readonly id = 'light';
  readonly label = 'Light (camera)';
  private stream: MediaStream | null = null;
  private handle = 0;
  private stopped = false;
  private readonly canvas = document.createElement('canvas');

  constructor(
    private readonly video: HTMLVideoElement,
    /** ROI side as a fraction of the shorter video dimension. Keep in sync with the aim box. */
    readonly roiFraction = 0.2,
  ) {
    this.canvas.width = 32;
    this.canvas.height = 32;
  }

  async start(onSample: (t: number, level: number) => void): Promise<void> {
    this.stopped = false;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, frameRate: { ideal: 60 } },
    });
    const video = this.video as VideoWithRvfc;
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    const onFrame = (now: number, meta: FrameMeta) => {
      if (this.stopped) return;
      const side = Math.min(video.videoWidth, video.videoHeight) * this.roiFraction;
      const sx = (video.videoWidth - side) / 2;
      const sy = (video.videoHeight - side) / 2;
      ctx.drawImage(video, sx, sy, side, side, 0, 0, 32, 32);
      const px = ctx.getImageData(0, 0, 32, 32).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      onSample(meta.captureTime ?? meta.expectedDisplayTime ?? now, sum / (px.length / 4) / 255);
      this.handle = video.requestVideoFrameCallback(onFrame);
    };
    this.handle = video.requestVideoFrameCallback(onFrame);
  }

  stop(): void {
    this.stopped = true;
    (this.video as VideoWithRvfc).cancelVideoFrameCallback?.(this.handle);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
