# FlashLink — Multi-bulb lanes, pulse-length coding, compression

**Date:** 2026-10-24
**Status:** Approved

## Goal

Send faster by blinking several light sources in parallel, each carrying part of the message. For now the iPhone screen simulates the bulbs (1–9 white tiles that only switch on/off, like real bulbs); later real bulbs replace the tiles with no receiver changes. In the same round, add pulse-length coding (~1.6× per light) and 6-bit text compression (~1.3×).

## Decisions

- **Data split:** one message is split across the bulbs (not repeated, not independent streams).
- **Bulb count:** adjustable 1–9 on the emitter.
- **Ordering:** each bulb's frame carries a header (message id, lane index, lane count), so the receiver reassembles by header, never by bulb position.
- **Coding:** pulse-length coding is new and default; Manchester stays. The receiver decodes both in parallel and accepts whichever passes the CRC.

## Protocol

### Text codec (6-bit)
- 6-bit codes for ~60 common characters (space, a–z, 0–9, common punctuation, newline) plus `SHIFT` (next letter upper-case), `ESCAPE` (next 8 bits are a raw UTF-8 byte, for anything else) and `END` (padding terminator).
- The sender uses it only when it is smaller than plain UTF-8; a header flag says which.
- The bit stream is prefix-decodable, so partially received text can be streamed.

### Lane frame (v2, replaces v1)
Modulator-specific preamble, then bits:

```
[sync 16 bits][msgId:4 | lane:4][lanes:4 | flags:4][length:8][chunk bytes][crc8 over header+length+chunk]
```

- `flags` bit 0: compressed.
- `encodeFrame(text)` remains as a convenience for a single-lane message.
- The message's (compressed) byte string is split into `lanes` contiguous chunks of near-equal size; lane `i` carries chunk `i`.

### Pulse-length modulation
- Data is carried by run lengths: each run (alternating on/off) lasts 1–4 slots = 2 bits.
- Preamble: 16 alternating 1-slot runs. The receiver locks the slot length on it and measures the turn-on skew (mean off-run minus mean on-run, halved), holding that skew for the rest of the frame.
- After the last data run, the modulator adds a terminating transition so the last run has an end edge.
- Run classification: `round((duration ± skew) / slot)` within 0.5–4.5 slots, else lost; the slot estimate adapts slowly.

### Multi-lane signal and scheduler
- `MultiTimedLevels { slotMs, lanes: Level[][] }`, lanes padded with darkness to equal length, followed by the repeat gap.
- `runSchedule` drives `setLevels(Level[])` for all lanes from one clock.

### Receivers
- `Receiver` (one light): edges, duty correction, **both** demodulators in parallel, each with its own frame decoder; emits per-lane `chunk` / `progress` events.
- `MultiReceiver`: `push(t, sources: {id, level}[])` keeps a `Receiver` per source id (dropped after ~3 s unseen) and assembles chunks by `msgId` into `message` events, streaming partial text from contiguous received chunks.

### Simulator
- Renders N lanes into per-lane samples sharing one camera clock, with jitter, per-lane turn-on delay, noise and dropped frames.

## Emitter

- Channels: **Torch** (1 lane) and **Screen bulbs** (1–9 lanes). Transmitters expose `maxLanes` and `setLevels(levels)`.
- Screen bulbs: while sending, a full-screen black view with N white tiles in a grid, driven by `Animated` values (no React re-render per slot), screen brightness at maximum (`expo-brightness`), and a small Stop button.
- Controls: channel, bulb-count stepper (screen only), coding (Pulse-length / Manchester), slot-length stepper, repeat toggle.

## Receiver

- **Light finder:** per-pixel blink activity (temporal variance); pixels above a relative threshold are grouped into connected blobs. Each blob is a source: its level is the brightest pixels in the blob minus the frame baseline (median).
- **Identity:** sources are matched frame to frame by nearest centroid, so a slowly moving light keeps its decoder; positions are re-detected continuously.
- **UI:** a small numbered marker per detected light (display only), a "Lights" stat, and the message feed fed by `MultiReceiver`.
- **Known risk:** separating lights reintroduces position tracking; hold the emitter phone fairly still. Fixed real bulbs won't move.

## Testing

- Unit: codec round-trip of arbitrary Unicode (shrinks English text by at least 20%); frame v2 encode/decode; split and reassemble; pulse-length encode/decode, including the terminating edge.
- Simulated end-to-end: pulse-length at 100 ms slots and 30 fps with jitter and turn-on delay; 4 lanes with independent per-lane jitter decode to the full message; Manchester still decodes.
- Light finder on synthetic frames: separates 4 tiles, ignores a steady lamp, keeps ids for slowly moving lights.
- Device tests with the dev-server logs.

## Expected throughput (30 fps receiver, 100 ms slots)

| Setup | chars/s |
|---|---|
| Today: torch, Manchester 200 ms | ~0.6 |
| 1 light, pulse-length + compression | ~1.3 |
| 4 lights | ~5 |
| 9 lights | ~11 |
