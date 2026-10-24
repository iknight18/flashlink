import { useColorScheme } from 'react-native';
import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular';
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium';
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular';
import { GeistMono_500Medium } from '@expo-google-fonts/geist-mono/500Medium';

export const fontAssets = {
  Geist_400Regular,
  Geist_500Medium,
  Geist_600SemiBold,
  GeistMono_400Regular,
  GeistMono_500Medium,
};

export const fonts = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  mono: 'GeistMono_400Regular',
  monoMedium: 'GeistMono_500Medium',
};

export interface Palette {
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accentSoft: string;
  accentInk: string;
  danger: string;
  dangerSoft: string;
  statusBar: 'light' | 'dark';
}

const dark: Palette = {
  bg: '#0e0e10',
  surface: '#161619',
  surface2: '#1d1d21',
  line: 'rgba(255,255,255,0.07)',
  text: '#ececef',
  muted: '#8d8d96',
  faint: '#5c5c64',
  accent: 'hsl(38, 70%, 58%)',
  accentSoft: 'hsla(38, 70%, 58%, 0.14)',
  accentInk: '#1c1407',
  danger: 'hsl(4, 60%, 62%)',
  dangerSoft: 'hsla(4, 60%, 62%, 0.12)',
  statusBar: 'light',
};

const light: Palette = {
  bg: '#f6f6f7',
  surface: '#ffffff',
  surface2: '#f0f0f2',
  line: 'rgba(24,24,27,0.08)',
  text: '#18181b',
  muted: '#6b6b74',
  faint: '#a1a1aa',
  accent: 'hsl(36, 72%, 44%)',
  accentSoft: 'hsla(36, 72%, 44%, 0.12)',
  accentInk: '#fffaf0',
  danger: 'hsl(4, 58%, 50%)',
  dangerSoft: 'hsla(4, 58%, 50%, 0.1)',
  statusBar: 'dark',
};

export function usePalette(): Palette {
  return useColorScheme() === 'light' ? light : dark;
}

export const spring = { stiffness: 220, damping: 22, mass: 1, useNativeDriver: true } as const;
