# MX Creative Console WebHID Library

Reusable browser JavaScript library for Logitech MX Creative Console devices (Keypad + Dialpad) over WebHID.

The repository includes:

- `js/mxCreativeConsole.js`: reusable library API for app developers
- `js/app.js`: demo integration used by `index.html`
- `examples/`: minimal integration examples

## Capabilities

- Device discovery + role classification (keypad vs dialpad)
- Rollers : diversion mode + live rotation events
- Special keys : merged key state updates
- Brightness : read/set in percent
- Contextual display upload : `single`, `all`, `full`

## Browser Support

- Chrome 89+
- Edge 89+
- Opera 75+

WebHID is not available in Firefox or Safari.

## Quick Start

### 1. Serve the folder over HTTP

```bash
npm install -g http-server
http-server -p 8000
```

Open `http://localhost:8000`.

### 2. Import the library

```html
<script type="module">
   import { MXCreativeConsoleClient } from './js/mxCreativeConsole.js';

   const client = new MXCreativeConsoleClient({ debug: true });

   client.on('status', ({ message, isError }) => {
      console.log(isError ? 'ERROR:' : 'INFO:', message);
   });

   client.on('devicesChanged', (devices) => {
      console.log('devices', devices);
   });

   await client.requestDeviceAccessAndScan();
</script>
```

### 3. Connect + enable events

```js
const devices = client.getAvailableDevices();
await client.connectAvailableDevice(devices[0].index);

client.on('keypadKeysChanged', ({ activeLabels }) => {
   console.log('keypad keys:', activeLabels);
});

client.on('rollerEvent', ({ rollerId, delta }) => {
   console.log('roller', rollerId, 'delta', delta);
});
```

## Library API

### Constructor

```js
const client = new MXCreativeConsoleClient({ debug?: boolean });
```

### Core methods

- `requestDeviceAccessAndScan()`
- `scanAuthorizedDevices()`
- `getAvailableDevices()`
- `connectAvailableDevice(index)`
- `disconnectRole('keypad' | 'dialpad')`
- `disconnectAll()`
- `getConnectionState()`

### Roller methods

- `setRollerDiverted(boolean)`
- `clearRollerEvents()`

### Brightness methods

- `refreshBrightness()`
- `setBrightnessPercent(percent)`

### Contextual display methods

- `uploadContextualDisplayImage(file, { mode, keyNumber })`
  - `mode`: `single` | `all` | `full`
  - `keyNumber`: `1..9` (used for `single`)

### Events

- `status` `{ message, isError }`
- `devicesChanged` `devices[]`
- `roleConnected` `{ role, deviceEntry }`
- `roleDisconnected` `{ role }`
- `stateChanged` `connectionState`
- `keypadKeysChanged` `{ source, activeControlIds, activeLabels }`
- `dialpadKeysChanged` `{ source, activeControlIds, activeLabels }`
- `rollerModeChanged` `{ mode, modeName, diverted }`
- `rollerEvent` `{ rollerId, delta, timestamp, eventCount, snapshot }`
- `rollerCleared` `{ eventCount }`
- `brightnessChanged` `{ raw, percent }`
- `imageUploadComplete` `{ mode, keyNumber? }`

## Examples

- `examples/basic-events.html`
  - Scan, connect, and print key/roller events.
- `examples/brightness-and-image.html`
  - Connect keypad, control brightness, and upload contextual images.
- `examples/keypad-demo.html`
  - Visual keypad demo with connect flow, key press highlights, and per-key image updates.
