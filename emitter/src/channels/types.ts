import type { ComponentType } from 'react';
import type { Level } from '@flashlink/protocol';

/** Drives one output. Timing comes from the shared runSchedule. */
export interface Transmitter {
  id: string;
  label: string;
  setLevel(level: Level): void;
}

export interface ChannelProps {
  /** Called with a ready transmitter, or null when it's unavailable/unmounted. */
  onReady(tx: Transmitter | null): void;
}

export interface ChannelDefinition {
  id: string;
  label: string;
  /** Mounted while the channel is selected; owns any hardware views/permissions. */
  Component: ComponentType<ChannelProps>;
}
