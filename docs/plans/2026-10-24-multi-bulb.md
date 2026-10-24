# Multi-bulb Implementation Plan

> **For Claude:** Execute task by task with superpowers:subagent-driven-development. Each task lists the contract (exported API) and the acceptance tests that define "done". Write the tests first, watch them fail, then implement. Use one commit per task, ending the message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Goal:** Lanes across 1–9 light sources, pulse-length coding, 6-bit compression (see `2026-10-24-multi-bulb-design.md`).

**Ground rules**
- Repo: `flashlink/` (npm workspaces). Protocol tests: `npm test -w protocol`; typecheck: `npm run typecheck -w protocol`. Receiver: `npm test -w receiver`, `npm run build -w receiver`. Emitter: `cd emitter && npx tsc --noEmit` and `npx expo export --platform ios --output-dir <scratch>`.
- Never loosen an existing test to make it pass. Existing tests may be **updated** only where this plan changes the behaviour they check (frame v1 to v2, single `message` to `chunk`). State each such change in the commit message.
- Keep the existing robustness tests (jitter/drop sweeps, slow-torch tests, keep-listening tests) passing for Manchester. Equivalent sweeps for pulse-length are new acceptance criteria.

---

## Protocol A

### Task A1: 6-bit text codec — `protocol/src/framing/textCodec.ts`
```ts
export function packText(text: string): Uint8Array;               // 6-bit stream, END-padded to a byte
export function unpackText(bytes: Uint8Array, partial?: boolean): string; // partial: decode what is complete, no throw
export function encodePayload(text: string): { bytes: Uint8Array; compressed: boolean }; // picks the smaller of packText / UTF-8
export function decodePayload(bytes: Uint8Array, compressed: boolean, partial?: boolean): string;
```
Tests:
- Round-trips `''`, `'Meet at the north gate, 21:40'`, `'MiXeD CaSe'`, `'héllo 👋 世界'`, every printable ASCII character, and newlines.
- `packText` of an English sentence is at least 20% smaller than UTF-8.
- `encodePayload` never returns more bytes than UTF-8.
- `unpackText(prefix, true)` of any byte prefix returns a prefix of the full text, never a broken character.

### Task A2: frame v2 — `protocol/src/framing/frame.ts`
```ts
export interface LaneHeader { msgId: number; lane: number; lanes: number; compressed: boolean } // msgId 0–15, lane 0–14, lanes 1–15
export function encodeLaneFrame(h: LaneHeader, chunk: Uint8Array): Bit[];  // starts at the 16-bit sync word (no preamble)
export function encodeFrame(text: string, msgId?: number): Bit[];          // single-lane convenience, uses encodePayload
export type FrameEvent =
  | { type: 'header'; header: LaneHeader; length: number }
  | { type: 'progress'; header: LaneHeader; bytes: Uint8Array; length: number }
  | { type: 'done'; header: LaneHeader; bytes: Uint8Array }
  | { type: 'error'; reason: 'crc' };
export class FrameDecoder { push(bit: Bit): FrameEvent | null; reset(): void; get reading(): boolean }
```
- The 16-bit sync word replaces the v1 12-bit preamble-tail sync. **Preambles move into the modulators.**
- The CRC-8 covers both header bytes, the length and the chunk.

Tests: v2 round-trip; header fields; corrupted bit gives `crc`; garbage before sync is ignored; two frames in a row; `length` 0; no false sync inside a random 1000-bit stream with probability ≤ 1 (seeded).

### Task A3: split and assemble — `protocol/src/framing/lanes.ts`
```ts
export function splitMessage(text: string, lanes: number, msgId: number): { header: LaneHeader; chunk: Uint8Array }[];
export class MessageAssembler {
  /** Returns the full text once every lane of `header.msgId` has arrived. */
  add(header: LaneHeader, bytes: Uint8Array): { text: string; complete: boolean } ;
  /** Streams text decodable from the contiguous chunks received so far (lane 0 onward), plus a live partial lane. */
  preview(msgId: number, liveLane?: number, liveBytes?: Uint8Array): string;
}
```
Tests: split then assemble for 1–9 lanes, in any arrival order; chunk sizes differ by at most 1 byte; a message with fewer bytes than lanes still works (empty chunks allowed); a new `msgId` clears stale partial state; a repeat of a completed message is reported again (the app counts repeats).

---

## Protocol B

### Task B1: modulators own their preamble
- `manchesterEncode(bits, bitMs)` keeps its signature but now **prepends** a 16-bit alternating preamble itself (frame bits no longer contain it). `ManchesterDecoder` is unchanged.
- New `protocol/src/modulation/pulse/encode.ts`:
  ```ts
  export function pulseEncode(bits: Bit[], slotMs: number): TimedLevels; // halfBitMs field = slotMs
  ```
  The preamble is 16 alternating 1-slot runs starting `on`. Each 2 data bits are one run of `1 + value` slots, alternating level. A terminating run is added so the last data run has an end edge, then the output ends dark. An odd bit count is padded with a 0 bit.
- New `protocol/src/modulation/pulse/decode.ts`: `PulseDecoder` with the same surface as `ManchesterDecoder` (`pushEdge`, `checkTimeout`, `reset`, `state`, `bitMs` meaning slot). It locks on ≥ 8 consistent 1-slot runs, measures skew in the preamble and holds it, and classifies runs as `round(corrected / slot)` in 1..4, otherwise resetting.
Tests: encode shape (preamble, run lengths, terminator); ideal-edge decode recovers the frame bits; a 33 ms turn-on delay is corrected; an impossible run resets; timeout.

### Task B2: `Receiver` runs both decoders
- Edges flow through `DutyCorrector` to **both** a `ManchesterDecoder` and a `PulseDecoder`, each with its own `FrameDecoder`. The first to produce a `done` with a valid CRC wins; both are then reset.
- Events (replacing the v1 `message` event):
  ```ts
  | { type: 'state'; state: 'HUNTING' | 'LOCKED' | 'READING' | 'DONE' }
  | { type: 'interval'; ms: number }
  | { type: 'progress'; header: LaneHeader; received: number; length: number; bytes: Uint8Array }
  | { type: 'chunk'; header: LaneHeader; bytes: Uint8Array; coding: 'pulse' | 'manchester' }
  | { type: 'error'; reason: 'crc' | 'lost' }
  ```
  `LOCKED`/`READING` reflect whichever decoder is furthest along. There is no stopped state (as now).
- Update existing receiver tests to the new events through a small test helper that assembles single-lane chunks to text, keeping every scenario and threshold.

New acceptance tests:
- Pulse-length at 100 ms slots, 30 fps, jitter ±8, noise 0.03, drop 0.01, seeds 1..300: at least 93% decode, zero wrong texts.
- Pulse-length with 25/33 ms turn-on delay: at least 90%.
- Manchester sweeps unchanged.
- A Manchester frame followed by a pulse-length frame both decode through one `Receiver`.

### Task B3: multi-lane signal, scheduler, simulator, `MultiReceiver`
```ts
export interface MultiTimedLevels { slotMs: number; lanes: Level[][] }
export function buildTransmission(text: string, o: { lanes: number; coding: 'pulse' | 'manchester'; slotMs: number; msgId: number; gapSlots?: number }): MultiTimedLevels;
export function runMultiSchedule(signal: MultiTimedLevels, setLevels: (levels: Level[]) => void, opts?: ScheduleOptions): Promise<void>; // runSchedule stays for single lane
export function simulateLanes(signal: MultiTimedLevels, o: SimOptions & { onDelayMsPerLane?: number[] }): { t: number; levels: number[] }[];
export class MultiReceiver {
  push(t: number, sources: { id: number; level: number }[]): MultiEvent[];
}
export type MultiEvent =
  | { type: 'sources'; sources: { id: number; state: ReceiverState }[] } // only when changed
  | { type: 'progress'; msgId: number; lanes: number; lanesDone: number; text: string }
  | { type: 'message'; msgId: number; text: string; lanes: number }
  | { type: 'error'; sourceId: number; reason: 'crc' | 'lost' };
```
- `buildTransmission` uses `encodePayload` and `splitMessage`, encodes each lane with the chosen modulator, then pads and appends `gapSlots` (default 8) of darkness.
- In `MultiReceiver`, a source unseen for 3 s is dropped.

Tests:
- 4 lanes, pulse-length, 100 ms slots, 30 fps, independent per-lane jitter and noise, seeds 1..100: at least 90% full messages, zero wrong texts.
- 9 lanes, ideal: decodes.
- Lanes arriving through sources with shuffled ids decode.
- Progress text grows monotonically.
- `runMultiSchedule` sets all lanes at the same absolute times (fake clock) and ends dark.

---

## Receiver app (after Protocol B)

### Task R1: light finder — `receiver/src/channels/light/lightFinder.ts`
```ts
export class LightFinder {
  constructor(width: number, height: number, opts?: { tauMs?: number; relThreshold?: number; noiseFloor?: number });
  push(t: number, luma: Float32Array): { id: number; level: number; cx: number; cy: number }[]; // cx/cy normalized 0–1
}
```
- Per-pixel variance EMA. Active pixels are those above `max(noiseFloor, relThreshold × max variance)`, grouped into 4-connected blobs.
- A blob's level is the mean of its top 30% brightest pixels minus the frame median.
- Ids are matched to the previous frame by nearest centroid within 8 cells; otherwise a new id is assigned.

Tests (synthetic frames): 4 tiles blinking independently produce 4 sources with stable ids over 3 s; a steady bright lamp produces no source; a 2×2 tile at 100 ms slots keeps contrast ≥ 0.4; a slowly drifting tile keeps its id; tiles 3 cells apart stay separate.

### Task R2: wire it up
- `CameraLightSensor` emits `sources` per frame (it replaces `lightLevel`). Change the `Sensor` interface to `start(onSample: (t: number, sources: {id: number; level: number; cx: number; cy: number}[]) => void)`.
- `main.ts` uses `MultiReceiver` (camera edge `minContrast: 0.04`). The feed shows `message` and `progress` events; repeats still count up; failed attempts fade out.
- Numbered markers per source on the video (absolute positioned, `transform` only), a **Lights** stat, and diagnostics stats per source (`level`, `contrast`, `state`).
- Build passes and receiver tests pass.

## Emitter app (after Protocol B)

### Task E1: multi-lane transmitters
- `Transmitter { id; label; maxLanes: number; setLevels(levels: Level[]): void }`. The Torch channel uses `maxLanes` 1. The app uses `buildTransmission` and `runMultiSchedule`.

### Task E2: Screen bulbs channel
- `npx expo install expo-brightness`.
- While sending: a full-screen black overlay with N tiles in a near-square grid (1, 2, 3, 4=2×2, 5–6=3×2, 7–9=3×3), large and with gaps of at least 15% of a tile. Tiles use `Animated.Value` opacity set directly from `setLevels`. Brightness goes to 1 during the send and is restored after, and a small Stop button sits in a corner.
- When idle, the channel row shows a mini preview of the grid.

### Task E3: controls
- Channel (Torch / Screen bulbs), bulb-count stepper 1–9 (screen only), coding (Pulse-length default / Manchester), slot-length stepper (rename the label to "Slot length"; with Manchester a bit is 2 slots), and the repeat toggle.
- The ETA uses the real signal length. Each new Send uses a new `msgId`; repeats reuse it.
- `tsc` and the iOS export pass.

---

## Role swap (2026-10-24, after Protocol B)

The user swapped the roles: the **laptop browser is the emitter** and the **iPhone is the receiver**. Expo Go can't read camera frames fast enough, so the phone receiver is the existing web app opened in iPhone Safari. This replaces the "Emitter app" tasks:

- **W1, phone receiver:** tasks R1 and R2 as written, on iPhone Safari (rear camera, `playsinline`; manual exposure is optional because iOS doesn't offer it). Add home-screen web-app metadata.
- **W2, browser emitter:** a new `emitter.html` page in the same Vite app. It has a message box, bulb stepper 1–9, coding (Pulse-length / Manchester), slot-length stepper and repeat toggle. Send shows a fullscreen black page with N white tiles (grid rules as in E2) driven by `runMultiSchedule` setting tile styles directly, keeps the screen awake with the Wake Lock API, and has a small Stop button. The two pages link to each other.
- **X1, Expo app:** a minimal port to the v2 API (torch is 1 lane via `buildTransmission`, plus a coding switch) so it keeps compiling and the torch still works as an alternative emitter.
