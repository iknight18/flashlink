# FlashLink

Send text from an iPhone's flashlight to any camera, with pluggable transfer channels (light now, sound next).

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

Measured: TODO (fill in the reliable speeds from the device checklist, Task 12 Step 1)

Design: `docs/plans/2026-10-23-flashlink-design.md`
