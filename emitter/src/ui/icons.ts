import type { Icon } from 'phosphor-react-native';

// Per-icon entry points keep the bundle small; the package's barrel pulls in every icon.
// `require` keeps tsc from type-checking phosphor's TS sources, which don't pass our strict settings.
/* eslint-disable @typescript-eslint/no-require-imports */
export const CameraIcon: Icon = require('phosphor-react-native/src/icons/Camera').CameraIcon;
export const CrosshairIcon: Icon = require('phosphor-react-native/src/icons/Crosshair').CrosshairIcon;
export const FlashlightIcon: Icon = require('phosphor-react-native/src/icons/Flashlight').FlashlightIcon;
export const PaperPlaneTiltIcon: Icon = require('phosphor-react-native/src/icons/PaperPlaneTilt').PaperPlaneTiltIcon;
export const StopIcon: Icon = require('phosphor-react-native/src/icons/Stop').StopIcon;
export const WarningCircleIcon: Icon = require('phosphor-react-native/src/icons/WarningCircle').WarningCircleIcon;
