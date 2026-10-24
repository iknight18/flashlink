export interface Sensor {
  id: string;
  label: string;
  /** Starts the hardware and reports one normalized level (0–1) per reading. */
  start(onSample: (timestampMs: number, level: number) => void): Promise<void>;
  stop(): void;
}

export interface SensorContext {
  video: HTMLVideoElement;
}

export interface ChannelDefinition {
  id: string;
  label: string;
  create(ctx: SensorContext): Sensor;
}
