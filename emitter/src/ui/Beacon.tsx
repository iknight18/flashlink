import { memo, useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { FlashlightIcon } from './icons';
import { usePalette } from './theme';

const SIZE = 112;

/**
 * Mirrors the output level (fed by `level.setValue`, outside React renders) and
 * breathes softly while the channel is ready and idle.
 */
export const Beacon = memo(function Beacon({ level, idle }: { level: Animated.Value; idle: boolean }) {
  const p = usePalette();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!idle) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 2200, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [idle, pulse]);

  return (
    <View style={styles.wrap}>
      <Animated.View
        style={[
          styles.ring,
          { borderColor: p.accent },
          {
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.28] }) }],
          },
        ]}
      />
      <View style={[styles.disc, { backgroundColor: p.surface2, borderColor: p.line }]}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.round, { backgroundColor: p.accent, opacity: level }]} />
        <View style={styles.icon}>
          <FlashlightIcon size={34} color={p.muted} />
          <Animated.View style={[StyleSheet.absoluteFill, styles.center, { opacity: level }]}>
            <FlashlightIcon size={34} weight="fill" color={p.accentInk} />
          </Animated.View>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 1.5 },
  disc: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  round: { borderRadius: SIZE / 2 },
  icon: { width: 34, height: 34 },
  center: { alignItems: 'center', justifyContent: 'center' },
});
