# FlashLink

Send text from an iPhone's flashlight to any camera. No network, no pairing: the phone blinks the message
and a web page reads it back through the camera, like a modern Aldis lamp.

## How it works

1. **Framing:** the text is packed (a 6-bit codec for plain text, UTF-8 otherwise), split into frames with
   a preamble, a 16-bit sync word, a small header and a CRC-8 check. Long messages split across several
   lanes, so several lights can carry one message in parallel.
2. **Modulation:** each bit is Manchester-coded (or pulse-length coded) into on/off torch timings. A
   scheduler keeps the timings steady despite the phone's timer jitter.
3. **Reception:** the receiver samples the brightness inside a target box on every camera frame, finds the
   edges, corrects the duty cycle, locks onto the sync word, and checks the CRC before showing the text.

The protocol is plain TypeScript with no browser or React Native dependency, and ships with a simulator
that adds camera frame rates, jitter and noise, so every change is tested against a realistic signal.

## Project layout

- `protocol/`: framing, Manchester coding, decoder pipeline, simulator (`npm test`)
- `emitter/`: Expo Go app (iPhone). `npm run emitter`, then scan the QR code with Expo Go
- `receiver/`: web app (any camera). `npm run receiver`, then open the https URL and accept the certificate

## Adding a channel

1. Emitter: implement `Transmitter.setLevel` in `emitter/src/channels/<name>/`, register it in `registry.ts`.
2. Receiver: implement `Sensor` (emit `(timestamp, level 0–1)`) in `receiver/src/channels/<name>/`, register it.

Framing, modulation and the scheduler are shared, so nothing in `protocol/` changes.

### Known limits

- In simulation, about 96% of messages decode at 200 ms/bit on a 30 fps camera. Use 200 ms/bit or slower on 30 fps cameras; 100 ms/bit needs a 60 fps camera.
- Keep the phone unlocked with the app in front while sending. Locking or backgrounding stops the torch.
- Keep the torch inside the red box, 10–30 cm from the receiving camera.

## Design notes

- Single light: `docs/plans/2026-10-23-flashlink-design.md`
- Several lights (lanes): `docs/plans/2026-10-24-multi-bulb-design.md`

## Licence

MIT, see `LICENSE`.
