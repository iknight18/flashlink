/** Normalized (0–1) rectangle in video coordinates. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sensor {
  id: string;
  label: string;
  /** Starts the hardware and reports one normalized level (0–1) per reading. */
  start(onSample: (timestampMs: number, level: number) => void): Promise<void>;
  stop(): void;
  /** Optional: freeze any adaptation (e.g. light tracking) while a frame is being read. */
  hold?(held: boolean): void;
  /** Optional: hardware details for diagnostics, available after start(). */
  describe?(): Record<string, unknown>;
}

export interface SensorContext {
  video: HTMLVideoElement;
  /** Optional: called when a camera-based sensor moves the region it reads from. */
  onRegion?(region: Region): void;
}

export interface ChannelDefinition {
  id: string;
  label: string;
  create(ctx: SensorContext): Sensor;
}
