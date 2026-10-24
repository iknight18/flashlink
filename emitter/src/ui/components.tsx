import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { fonts, spring, usePalette } from './theme';

/** Pressable that dips slightly under the finger, with a light haptic tap. */
export function PressableScale({
  onPress, disabled, style, children, haptic = true,
}: {
  onPress(): void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  haptic?: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (value: number) => Animated.spring(scale, { toValue: value, ...spring }).start();
  return (
    <Pressable
      disabled={disabled}
      onPressIn={() => to(0.97)}
      onPressOut={() => to(1)}
      onPress={() => {
        if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress();
      }}
    >
      <Animated.View style={[style, { transform: [{ scale }] }, disabled && { opacity: 0.45 }]}>{children}</Animated.View>
    </Pressable>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  const p = usePalette();
  return <Text style={[styles.label, { color: p.muted }]}>{children}</Text>;
}

/** Segmented control with a sliding thumb. */
export function Segmented<T extends string | number>({
  options, value, onChange, disabled,
}: {
  options: { value: T; label: string; detail?: string }[];
  value: NoInfer<T>;
  onChange(value: NoInfer<T>): void;
  disabled?: boolean;
}) {
  const p = usePalette();
  const [width, setWidth] = useState(0);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const x = useRef(new Animated.Value(index)).current;
  useEffect(() => {
    Animated.spring(x, { toValue: index, ...spring }).start();
  }, [index, x]);
  const slot = width / options.length;

  return (
    <View
      style={[styles.segmented, { backgroundColor: p.surface2, borderColor: p.line }, disabled && { opacity: 0.5 }]}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width - 8)}
    >
      {width > 0 && (
        <Animated.View
          style={[
            styles.thumb,
            { width: slot, backgroundColor: p.surface, borderColor: p.line },
            { transform: [{ translateX: Animated.multiply(x, slot) }] },
          ]}
        />
      )}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            style={styles.segment}
            disabled={disabled}
            onPress={() => {
              if (!active) Haptics.selectionAsync().catch(() => {});
              onChange(o.value);
            }}
          >
            <Text style={[styles.segmentLabel, { color: active ? p.text : p.muted }]}>{o.label}</Text>
            {o.detail && <Text style={[styles.segmentDetail, { color: active ? p.muted : p.faint }]}>{o.detail}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontFamily: fonts.medium, fontSize: 12, letterSpacing: 0.5, textTransform: 'uppercase' },
  segmented: { flexDirection: 'row', padding: 4, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  thumb: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    left: 4,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 9, gap: 1 },
  segmentLabel: { fontFamily: fonts.monoMedium, fontSize: 15 },
  segmentDetail: { fontFamily: fonts.regular, fontSize: 11 },
});
