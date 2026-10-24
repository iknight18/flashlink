import { useCallback, useRef, useState } from 'react';
import { Animated, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  calibrationSignal, encodeFrame, manchesterEncode, MAX_PAYLOAD, PREAMBLE_BITS,
  runSchedule, utf8Length, type Level, type TimedLevels,
} from '@flashlink/protocol';
import { channels } from './src/channels/registry';
import type { Transmitter } from './src/channels/types';
import { Beacon } from './src/ui/Beacon';
import { PressableScale, SectionLabel, Segmented } from './src/ui/components';
import { CrosshairIcon, FlashlightIcon, PaperPlaneTiltIcon, StopIcon, WarningCircleIcon } from './src/ui/icons';
import { fontAssets, fonts, usePalette } from './src/ui/theme';

const SPEEDS = [
  { value: 400, label: '400', detail: 'Steady' },
  { value: 200, label: '200', detail: 'Normal' },
  { value: 100, label: '100', detail: 'Fast' },
];

type Job = { kind: 'send' | 'calibrate'; progress: number; startedAt: number; durationMs: number };

export default function App() {
  const [loaded] = useFonts(fontAssets);
  return (
    <SafeAreaProvider>
      {loaded ? <Emitter /> : <Splash />}
    </SafeAreaProvider>
  );
}

function Splash() {
  const p = usePalette();
  return <View style={{ flex: 1, backgroundColor: p.bg }} />;
}

function Emitter() {
  const p = usePalette();
  const [text, setText] = useState('Meet at the north gate, 21:40');
  const [bitMs, setBitMs] = useState(200);
  const [channelId, setChannelId] = useState(channels[0].id);
  const [job, setJob] = useState<Job | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const tx = useRef<Transmitter | null>(null);
  const abort = useRef<AbortController | null>(null);
  const level = useRef(new Animated.Value(0)).current;
  const onReady = useCallback((t: Transmitter | null) => {
    tx.current = t;
    setReady(t !== null);
  }, []);

  const channel = channels.find((c) => c.id === channelId)!;
  const bytes = utf8Length(text);
  const tooLong = bytes > MAX_PAYLOAD;
  const empty = bytes === 0;
  const seconds = ((PREAMBLE_BITS + 8 * (3 + bytes)) * bitMs) / 1000;
  const busy = job !== null;

  async function play(kind: Job['kind'], signal: TimedLevels) {
    if (abort.current) return;
    if (!tx.current) {
      setError('The flashlight is not ready yet. Allow camera access and wait for the preview to start.');
      return;
    }
    setError(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const durationMs = signal.levels.length * signal.halfBitMs;
    setJob({ kind, progress: 0, startedAt: Date.now(), durationMs });
    const setLevel = (l: Level) => {
      tx.current?.setLevel(l);
      level.setValue(l);
    };
    try {
      await activateKeepAwakeAsync('flashlink-tx');
      await runSchedule(signal, setLevel, {
        abort: ctrl.signal,
        onProgress: (done, total) => setJob((j) => j && { ...j, progress: done / total }),
      });
      if (!ctrl.signal.aborted) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        if (kind === 'send') setLastSent(text);
      }
    } finally {
      level.setValue(0);
      deactivateKeepAwake('flashlink-tx').catch(() => {});
      abort.current = null;
      setJob(null);
    }
  }

  const fail = (e: unknown) => setError(String(e));
  const status = describe(job, ready, lastSent);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: p.bg }]} edges={['top', 'bottom']}>
      <StatusBar style={p.statusBar} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.screen}
      >
        <View style={styles.header}>
          <View style={[styles.mark, { backgroundColor: p.accentSoft }]}>
            <FlashlightIcon size={18} color={p.accent} />
          </View>
          <Text style={[styles.brand, { color: p.text }]}>FlashLink</Text>
          <Text style={[styles.role, { color: p.muted, borderColor: p.line }]}>Emitter</Text>
        </View>

        <View style={styles.hero}>
          <Beacon level={level} idle={ready && !busy} />
          <View style={styles.heroCopy}>
            <Text style={[styles.heroTitle, { color: p.text }]}>{status.title}</Text>
            <Text style={[styles.heroText, { color: p.muted }]} numberOfLines={3}>{status.text}</Text>
            {job && (
              <Text style={[styles.heroMeta, { color: p.accent }]}>
                {Math.round(job.progress * 100)}% · {Math.max(0, Math.ceil((job.durationMs * (1 - job.progress)) / 1000))} s left
              </Text>
            )}
          </View>
        </View>

        {channels.length > 1 && (
          <View style={styles.block}>
            <SectionLabel>Channel</SectionLabel>
            <Segmented
              options={channels.map((c) => ({ value: c.id, label: c.label }))}
              value={channelId}
              onChange={setChannelId}
              disabled={busy}
            />
          </View>
        )}
        <channel.Component onReady={onReady} />

        <View style={styles.block}>
          <SectionLabel>Message</SectionLabel>
          <TextInput
            style={[styles.input, { color: p.text, backgroundColor: p.surface, borderColor: tooLong ? p.danger : p.line }]}
            value={text}
            onChangeText={setText}
            multiline
            editable={!busy}
            placeholder="Type what the light should say"
            placeholderTextColor={p.faint}
            selectionColor={p.accent}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
          />
          <Text style={[styles.helper, { color: tooLong ? p.danger : p.muted }]}>
            {tooLong
              ? `${bytes - MAX_PAYLOAD} bytes over the ${MAX_PAYLOAD}-byte limit`
              : `${bytes} / ${MAX_PAYLOAD} bytes · about ${Math.ceil(seconds)} s at ${bitMs} ms per bit`}
          </Text>
        </View>

        <View style={styles.block}>
          <SectionLabel>Bit length (ms)</SectionLabel>
          <Segmented options={SPEEDS} value={bitMs} onChange={setBitMs} disabled={busy} />
          <Text style={[styles.helper, { color: p.muted }]}>
            {bitMs === 100 ? 'Needs a 60 fps receiver camera.' : bitMs === 200 ? 'Works with most 30 fps cameras.' : 'Most forgiving. Use it for long distances or diffuse light.'}
          </Text>
        </View>

        {busy ? (
          <View style={styles.block}>
            <View style={[styles.track, { backgroundColor: p.surface2 }]}>
              <View style={[styles.fill, { backgroundColor: p.accent, transform: [{ scaleX: job.progress }] }]} />
            </View>
            <PressableScale onPress={() => abort.current?.abort()} style={[styles.button, styles.outline, { borderColor: p.line }]}>
              <StopIcon size={18} color={p.text} weight="fill" />
              <Text style={[styles.buttonText, { color: p.text }]}>Stop</Text>
            </PressableScale>
          </View>
        ) : (
          <View style={styles.actions}>
            <PressableScale
              onPress={() => play('send', manchesterEncode(encodeFrame(text), bitMs)).catch(fail)}
              disabled={tooLong || empty}
              style={[styles.button, styles.primary, { backgroundColor: p.accent }]}
            >
              <PaperPlaneTiltIcon size={18} color={p.accentInk} weight="bold" />
              <Text style={[styles.buttonText, { color: p.accentInk }]}>Send</Text>
            </PressableScale>
            <PressableScale
              onPress={() => play('calibrate', calibrationSignal(bitMs, 10_000)).catch(fail)}
              style={[styles.button, styles.outline, { borderColor: p.line }]}
            >
              <CrosshairIcon size={18} color={p.text} />
              <Text style={[styles.buttonText, { color: p.text }]}>Calibrate</Text>
            </PressableScale>
          </View>
        )}

        {error && (
          <View style={[styles.alert, { backgroundColor: p.dangerSoft }]}>
            <WarningCircleIcon size={18} color={p.danger} />
            <Text style={[styles.alertText, { color: p.danger }]}>{error}</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function describe(job: Job | null, ready: boolean, lastSent: string | null): { title: string; text: string } {
  if (job?.kind === 'send') return { title: 'Sending', text: 'Keep the flashlight pointed at the receiver.' };
  if (job?.kind === 'calibrate') return { title: 'Calibrating', text: 'Steady blinking for 10 seconds so the receiver can lock on.' };
  if (!ready) return { title: 'Getting ready', text: 'The flashlight needs camera access first.' };
  if (lastSent) return { title: 'Sent', text: `"${lastSent}"` };
  return { title: 'Ready', text: 'Calibrate once, then send your message.' };
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  screen: { paddingHorizontal: 20, paddingBottom: 32, gap: 24 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8 },
  mark: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  brand: { fontFamily: fonts.semibold, fontSize: 17, letterSpacing: -0.3 },
  role: { fontFamily: fonts.regular, fontSize: 13, paddingLeft: 10, borderLeftWidth: StyleSheet.hairlineWidth },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 20, paddingVertical: 4 },
  heroCopy: { flex: 1, gap: 4 },
  heroTitle: { fontFamily: fonts.semibold, fontSize: 26, letterSpacing: -0.8 },
  heroText: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  heroMeta: { fontFamily: fonts.monoMedium, fontSize: 13, marginTop: 4 },
  block: { gap: 8 },
  input: {
    fontFamily: fonts.regular,
    fontSize: 17,
    lineHeight: 24,
    minHeight: 96,
    padding: 14,
    paddingTop: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    textAlignVertical: 'top',
  },
  helper: { fontFamily: fonts.regular, fontSize: 13 },
  actions: { gap: 10 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 14,
  },
  primary: {},
  outline: { borderWidth: 1 },
  buttonText: { fontFamily: fonts.semibold, fontSize: 16 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: '100%', width: '100%', transformOrigin: 'left' },
  alert: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: 14, alignItems: 'flex-start' },
  alertText: { flex: 1, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
});
