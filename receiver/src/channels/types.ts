/** One light seen by a sensor in one reading. */
export interface SensorSource {
  /** Stable while the sensor keeps tracking the same light. */
  id: number;
  /** Normalized level (0–1). */
  level: number;
  /** Position in the sensor's picture, normalized 0–1 (for markers). */
  cx: number;
  cy: number;
}

export interface Sensor {
  id: string;
  label: string;
  /** Starts the hardware and reports every light it sees, once per reading. */
  start(onSample: (timestampMs: number, sources: SensorSource[]) => void): Promise<void>;
  stop(): void;
  /** Optional: hardware details for diagnostics, available after start(). */
  describe?(): Record<string, unknown>;
}

export interface SensorContext {
  video: HTMLVideoElement;
}

export interface ChannelDefinition {
  id: string;
  label: string;
  create(ctx: SensorContext): Sensor;
}
