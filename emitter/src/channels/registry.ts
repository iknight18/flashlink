import type { ChannelDefinition } from './types';
import { LightChannel } from './light/LightChannel';

// Add new channels (e.g. sound via speaker) here.
export const channels: ChannelDefinition[] = [
  { id: 'light', label: 'Light (torch)', Component: LightChannel },
];
