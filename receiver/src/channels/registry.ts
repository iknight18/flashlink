import type { ChannelDefinition } from './types';
import { CameraLightSensor } from './light/cameraSensor';

// Add new channels (e.g. sound via microphone) here.
export const channels: ChannelDefinition[] = [
  { id: 'light', label: 'Light (camera)', create: ({ video }) => new CameraLightSensor(video) },
];
