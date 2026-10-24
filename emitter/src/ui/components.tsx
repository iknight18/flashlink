import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { MinusIcon, PlusIcon } from './icons';
import { fonts, spring, usePalette } from './theme';

/** Pressable that dips slightly under the finger, with a light haptic tap. */
export function PressableScale({
  onPress, onPressIn, onPressOut, disabled, style, children, haptic = true,
}: {
  onPress(): void;
  onPressIn?(): void;
  onPressOut?(): void;
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
      onPressIn={() => {
        to(0.97);
        onPressIn?.();
      }}
      onPressOut={() => {
        to(1);
        onPressOut?.();
      }}
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

/** Number stepper: tap to step once, hold to keep stepping. */
export function Stepper({
  value, onChange, step, min, max, unit, disabled,
}: {
  value: number;
  onChange(value: number): void;
  step: number;
  min: number;
  max: number;
  unit: string;
  disabled?: boolean;
}) {
  const p = usePalette();
  const latest = useRef(value);
  latest.current = value;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopRepeat = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stopRepeat, []);

  const nudge = (dir: 1 | -1) => {
    const next = Math.min(max, Math.max(min, latest.current + dir * step));
    if (next === latest.current) {
      stopRepeat(); // at a limit the button disables itself and may never see the finger lift
      return;
    }
    latest.current = next;
    Haptics.selectionAsync().catch(() => {});
    onChange(next);
  };

  const button = (dir: 1 | -1) => {
    const atLimit = dir === 1 ? value >= max : value <= min;
    const Icon = dir === 1 ? PlusIcon : MinusIcon;
    return (
      <PressableScale
        haptic={false}
        disabled={disabled || atLimit}
        onPress={() => {}}
        onPressIn={() => {
          nudge(dir);
          stopRepeat();
          timer.current = setInterval(() => nudge(dir), 120);
        }}
        onPressOut={stopRepeat}
        style={[styles.stepBtn, { backgroundColor: p.surface, borderColor: p.line }]}
      >
        <Icon size={20} color={p.text} weight="bold" />
      </PressableScale>
    );
  };

  return (
    <View style={[styles.stepper, { backgroundColor: p.surface2, borderColor: p.line }, disabled && { opacity: 0.5 }]}>
      {button(-1)}
      <View style={styles.stepValue}>
        <Text style={[styles.stepNumber, { color: p.text }]}>{value}</Text>
        <Text style={[styles.stepUnit, { color: p.muted }]}>{unit}</Text>
      </View>
      {button(1)}
    </View>
  );
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
  stepper: { flexDirection: 'row', alignItems: 'center', padding: 4, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  stepBtn: { width: 52, height: 44, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  stepValue: { flex: 1, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 4 },
  stepNumber: { fontFamily: fonts.monoMedium, fontSize: 22, letterSpacing: -0.5 },
  stepUnit: { fontFamily: fonts.regular, fontSize: 13 },
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
