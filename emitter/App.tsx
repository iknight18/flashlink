import { useCallback, useRef, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  calibrationSignal, encodeFrame, manchesterEncode, MAX_PAYLOAD, PREAMBLE_BITS,
  runSchedule, utf8Length, type TimedLevels,
} from '@flashlink/protocol';
import { channels } from './src/channels/registry';
import type { Transmitter } from './src/channels/types';

const SPEEDS = [400, 200, 100];

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress(): void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={active ? styles.chipTextActive : undefined}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const [text, setText] = useState('Hello from FlashLink');
  const [bitMs, setBitMs] = useState(200);
  const [channelId, setChannelId] = useState(channels[0].id);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tx = useRef<Transmitter | null>(null);
  const abort = useRef<AbortController | null>(null);
  const onReady = useCallback((t: Transmitter | null) => { tx.current = t; }, []);

  const channel = channels.find((c) => c.id === channelId)!;
  const bytes = utf8Length(text);
  const tooLong = bytes > MAX_PAYLOAD;
  const seconds = ((PREAMBLE_BITS + 8 * (3 + bytes)) * bitMs) / 1000;
  const busy = progress !== null;

  async function play(signal: TimedLevels) {
    if (abort.current) return;
    if (!tx.current) { setError('Channel not ready; grant permission first.'); return; }
    setError(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    setProgress(0);
    try {
      await activateKeepAwakeAsync('flashlink-tx');
      await runSchedule(signal, (l) => tx.current?.setLevel(l), {
        abort: ctrl.signal,
        onProgress: (done, total) => setProgress(done / total),
      });
    } finally {
      deactivateKeepAwake('flashlink-tx').catch(() => {});
      abort.current = null;
      setProgress(null);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.screen}>
        <Text style={styles.title}>FlashLink Emitter</Text>

        <Text style={styles.label}>Channel</Text>
        <View style={styles.row}>
          {channels.map((c) => (
            <Chip key={c.id} label={c.label} active={c.id === channelId} onPress={() => !busy && setChannelId(c.id)} />
          ))}
        </View>
        <channel.Component onReady={onReady} />

        <Text style={styles.label}>Message</Text>
        <TextInput style={styles.input} value={text} onChangeText={setText} multiline editable={!busy}
          returnKeyType="done" submitBehavior="blurAndSubmit" />
        <Text style={tooLong ? styles.error : styles.hint}>
          {bytes}/{MAX_PAYLOAD} bytes · ~{seconds.toFixed(0)} s at {bitMs} ms/bit
        </Text>

        <Text style={styles.label}>Speed (ms per bit)</Text>
        <View style={styles.row}>
          {SPEEDS.map((s) => (
            <Chip key={s} label={`${s}`} active={s === bitMs} onPress={() => !busy && setBitMs(s)} />
          ))}
        </View>

        {busy ? (
          <>
            <View style={styles.bar}><View style={[styles.fill, { width: `${(progress ?? 0) * 100}%` }]} /></View>
            <Pressable style={styles.button} onPress={() => abort.current?.abort()}>
              <Text style={styles.buttonText}>Stop</Text>
            </Pressable>
          </>
        ) : (
          <View style={styles.row}>
            <Pressable
              style={[styles.button, tooLong && styles.disabled]}
              disabled={tooLong}
              onPress={() => play(manchesterEncode(encodeFrame(text), bitMs)).catch((e) => setError(String(e)))}
            >
              <Text style={styles.buttonText}>Send</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.secondary]} onPress={() => play(calibrationSignal(bitMs, 10_000)).catch((e) => setError(String(e)))}>
              <Text style={styles.buttonText}>Calibrate (10 s)</Text>
            </Pressable>
          </View>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  screen: { padding: 20, gap: 8 },
  title: { fontSize: 24, fontWeight: '700', marginVertical: 12 },
  label: { fontWeight: '600', marginTop: 12 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: '#888' },
  chipActive: { backgroundColor: '#0a84ff', borderColor: '#0a84ff' },
  chipTextActive: { color: '#fff' },
  input: { borderWidth: 1, borderColor: '#888', borderRadius: 8, padding: 10, minHeight: 80, fontSize: 16 },
  hint: { color: '#888' },
  error: { color: '#ff3b30' },
  bar: { height: 8, backgroundColor: '#8884', borderRadius: 4, overflow: 'hidden', marginTop: 16 },
  fill: { height: '100%', backgroundColor: '#0a84ff' },
  button: { backgroundColor: '#0a84ff', paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10, marginTop: 16 },
  secondary: { backgroundColor: '#5e5ce6' },
  disabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontWeight: '600' },
});
