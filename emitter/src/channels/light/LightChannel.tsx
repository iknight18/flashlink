import { useEffect, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { ChannelProps } from '../types';

/** The torch only works while a CameraView is mounted, so we keep a tiny preview. */
export function LightChannel({ onReady }: ChannelProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const granted = permission?.granted ?? false;

  useEffect(() => {
    onReady(granted ? { id: 'light', label: 'Light (torch)', setLevel: (l) => setTorch(l === 1) } : null);
    return () => onReady(null);
  }, [granted, onReady]);

  if (!permission) return null;
  if (!granted) {
    return (
      <View style={styles.box}>
        <Text>Camera access is needed to control the flashlight.</Text>
        <Button title="Allow camera" onPress={requestPermission} />
      </View>
    );
  }
  return (
    <View style={styles.box}>
      <CameraView style={styles.preview} facing="back" enableTorch={torch} />
      <Text>Torch: {torch ? 'ON' : 'off'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  preview: { width: 48, height: 48, borderRadius: 8, overflow: 'hidden' },
});
