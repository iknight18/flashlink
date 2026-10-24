# FlashLink — Design

**Date:** 2026-10-23
**Status:** Approved

## Goal

Send a text message from one phone to another device using a physical side channel. v1 uses the iPhone's flashlight (LED) as the emitter and a camera as the receiver. The architecture treats the transfer method as a pluggable **channel** so sound (speaker → microphone) and others can be added later without touching the protocol.

## Constraints

- Developer machine is Windows, no Mac → no native Swift/Xcode builds.
- Emitter device is an iPhone → emitter runs in **Expo Go** (React Native, `expo-camera` torch). No paid Apple developer account needed.
- Receiver must work on any device with a camera and a browser (iPhone, Android, laptop) → **web app**.
- Mobile browsers require HTTPS for camera/mic access.

## Architecture

TypeScript monorepo:

```
flashlink/
  protocol/   framing/ · modulation/manchester/ · simulator/ · tests
  emitter/    Expo app       — channels/light/   (channels/sound/ later)
  receiver/   Vite web app   — channels/light/   (channels/sound/ later)
```

### Layers

```
                EMITTER                                 RECEIVER
  text                                       text
   │                                          ▲
 [Framing]  bytes → bits                    [Framing]  bits → bytes, CRC check
   │                                          ▲
 [Modulator]  bits → timed levels           [Demodulator]  samples → bits
   │   (v1: Manchester on/off)                ▲   (v1: Manchester edge-timing decoder)
 [Transmitter]  drives hardware             [Sensor]  hardware → (timestampMs, level 0–1)
     light: torch   (sound: speaker)            light: camera ROI brightness   (sound: mic + Goertzel)
```

- **Framing** is channel-agnostic and shared by every channel.
- **Manchester modulation** is not light-specific; a v1 sound channel can reuse it as tone on/off. Faster schemes (e.g. FSK) become additional modulators; framing is unchanged.

### Channel interfaces

```ts
// emitter — channels only drive the hardware; one shared scheduler
// (protocol/runSchedule) times the levels for every channel.
interface Transmitter {
  id: string; label: string;
  setLevel(level: 0 | 1): void;   // torch on/off, tone on/off, …
}

// receiver
interface Sensor {
  id: string; label: string;
  start(onSample: (timestampMs: number, level: number) => void): Promise<void>;
  stop(): void;
}
```

Each app has a **channel registry** that populates a channel picker in the UI. v1 registers only `light`.

## Protocol

### Frame

```
[preamble: 16 bits 1010…] [sync: 0xD5] [length: 1 byte] [payload: UTF-8, ≤255 bytes] [CRC-8]
```

- Preamble lets the receiver measure the actual bit period and set its threshold.
- Sync byte marks the start of the header.
- Length bounds the read; CRC-8 rejects corrupted frames.

### Manchester line coding

- Each bit → two half-bits: `1` = high→low, `0` = low→high. Guarantees a transition every bit for clock recovery.
- Bit period configurable: 400 / 200 / 100 ms. **Default 200 ms** (~0.6 chars/s), tuned down after calibration.

## Emitter (Expo Go)

- UI: message input, Send, speed picker, channel picker (Light only), progress (bits sent / total), Calibrate button.
- Light transmitter: `CameraView` from `expo-camera` with `enableTorch`; the view must stay mounted (tiny/hidden preview).
- Scheduler: targets absolute timestamps (`start + n × halfBit`) using `performance.now()`; never chained `setTimeout`, so jitter doesn't accumulate.
- Calibration mode: steady 1010… pattern for 10 s.
- Enforces 255-byte payload limit.

## Receiver (web)

1. **Sensor (light):** `getUserMedia` rear camera; `requestVideoFrameCallback` for per-frame timestamps; average luminance inside a centred aim box (ROI) → one level per frame.
2. **Adaptive threshold:** midpoint of rolling min/max of the level.
3. **Demodulator:** decodes from *intervals between edges* (≈½ bit vs ≈1 bit), not fixed sample points. Tolerates 30 fps, dropped frames, torch jitter.
4. **State machine:** `HUNTING` (find preamble) → `LOCKED` (bit period estimated) → `READING` (length, payload, CRC) → `DONE` / `ERROR`.
5. UI: live brightness graph, state badge, decoded text, channel picker. Calibration view shows an edge-timing histogram to choose the fastest reliable speed.

## Error handling

| Situation | Behaviour |
|---|---|
| CRC mismatch | Show "corrupted — resend" with best-guess text, return to `HUNTING` |
| No edge for > 3 bit periods mid-frame | Timeout, return to `HUNTING` |
| Camera permission denied / not HTTPS | Explicit error screen with fix instructions |
| Payload > 255 bytes | Blocked in the emitter UI |

## HTTPS

- Dev: Vite + `@vitejs/plugin-basic-ssl`, served on the LAN; accept the certificate warning once per device.
- Later (optional): GitHub Pages deployment.

## Testing

- `protocol` unit tests: framing round-trip, CRC, Manchester encode/decode edge cases.
- Simulator tests: synthesise a 30 fps level stream from an encoded frame with ±30% timing jitter, noise and dropped frames; assert the decoder recovers the message. Runs entirely on Windows.
- Manual device checklist: calibrate, then send test strings at each speed.

## Out of scope for v1

- Sound channel (planned next; folder slots and registry already exist).
- Screen-flash channel, bidirectional/ACK, multi-frame messages > 255 bytes, error correction beyond CRC.
