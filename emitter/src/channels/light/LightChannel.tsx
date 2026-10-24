import { useEffect, useRef, useState } from 'react';
import { Animated, Linking, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { ChannelProps } from '../types';
import { PressableScale } from '../../ui/components';
import { CameraIcon } from '../../ui/icons';
import { fonts, usePalette } from '../../ui/theme';

/** The torch only works while a CameraView is mounted, so we keep a tiny preview. */
export function LightChannel({ onReady }: ChannelProps) {
  const p = usePalette();
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const granted = permission?.granted ?? false;

  useEffect(() => {
    onReady(granted && cameraReady ? { id: 'light', label: 'Light (torch)', setLevel: (l) => setTorch(l === 1) } : null);
    return () => onReady(null);
  }, [granted, cameraReady, onReady]);

  // The CameraView unmounts when permission is lost; a remount must wait for a fresh onCameraReady.
  useEffect(() => { if (!granted) setCameraReady(false); }, [granted]);

  if (!permission) return <SkeletonRow />;

  if (!granted) {
    const blocked = !permission.canAskAgain;
    return (
      <View style={[styles.row, { borderColor: p.line }]}>
        <View style={[styles.tile, { backgroundColor: p.surface2 }]}>
          <CameraIcon size={20} color={p.muted} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.title, { color: p.text }]}>Camera access needed</Text>
          <Text style={[styles.text, { color: p.muted }]}>
            {blocked ? 'Access was denied. Turn it on in Settings to use the flashlight.' : 'iOS only lets apps drive the flashlight through the camera.'}
          </Text>
        </View>
        <PressableScale
          onPress={() => (blocked ? Linking.openSettings() : requestPermission())}
          style={[styles.smallBtn, { backgroundColor: p.accentSoft }]}
        >
          <Text style={[styles.smallBtnText, { color: p.accent }]}>{blocked ? 'Settings' : 'Allow'}</Text>
        </PressableScale>
      </View>
    );
  }

  return (
    <View style={[styles.row, { borderColor: p.line }]}>
      <View style={[styles.tile, { backgroundColor: p.surface2 }]}>
        <CameraView style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} onCameraReady={() => setCameraReady(true)} />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.title, { color: p.text }]}>Flashlight</Text>
        <Text style={[styles.text, { color: p.muted }]}>{cameraReady ? 'Ready. Keep this screen open while sending.' : 'Starting the camera…'}</Text>
      </View>
    </View>
  );
}

function SkeletonRow() {
  const p = usePalette();
  const shimmer = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [shimmer]);
  return (
    <Animated.View style={[styles.row, { borderColor: p.line, opacity: shimmer }]}>
      <View style={[styles.tile, { backgroundColor: p.surface2 }]} />
      <View style={styles.copy}>
        <View style={[styles.bar, { width: '40%', backgroundColor: p.surface2 }]} />
        <View style={[styles.bar, { width: '75%', backgroundColor: p.surface2 }]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tile: { width: 44, height: 44, borderRadius: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, gap: 2 },
  title: { fontFamily: fonts.medium, fontSize: 15 },
  text: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
  smallBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  smallBtnText: { fontFamily: fonts.semibold, fontSize: 14 },
  bar: { height: 10, borderRadius: 5, marginVertical: 3 },
});
