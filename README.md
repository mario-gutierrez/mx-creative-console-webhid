# MX Creative Console WebHID Monitor

A browser-based WebHID monitor for MX Creative devices (Dialpad and Keypad profiles).

## What It Does

1. Scans authorized Logitech devices and shows connectable targets in-app
2. Resolves friendly device names using Feature `0x0007` when available
3. Monitors roller movement using Feature `0x4610` when supported
4. Monitors keypad key states using:
   - raw report `0x13` key list parsing
   - Feature `0x1B04` diverted key updates
5. Shows a persistent keypad widget for 3x3 keys plus PREV/NEXT bottom keys
6. Provides brightness controls using Feature `0x8040` (percent UI with raw range mapping)
7. Uploads contextual display images with Feature `0x19A1`:
   - update one key (1-9)
   - replicate one image to all 9 keys
   - map one image across the full keypad display

## Browser Support

- Chrome 89+
- Edge 89+
- Opera 75+

WebHID is not available in Firefox or Safari.

## Feature Mapping

- `0x4610` MultiRoller: capabilities, mode control, rotation events
- `0x1B04` SpecialKeys: diversion reporting and diverted key state updates
- `0x8040` BrightnessControl: get brightness info, read current brightness, set brightness
- `0x19A1` ContextualDisplay: query display capabilities/info and upload key/full-screen image payloads over VLP
- `0x0007` DeviceFriendlyName: friendly device naming in connect list

## Run Locally

### Option: Node `http-server`

```bash
npm install -g http-server
http-server -p 8000
```

Open: `http://localhost:8000`

## Usage

1. Click `Scan / Grant Devices` and grant access in the browser picker
2. Choose a device from `Available Devices to Connect`
3. After connection:
   - keypad monitor becomes active
   - if rollers are supported, roller monitoring and diversion toggle are shown
   - if brightness is supported, brightness controls are shown
   - if contextual display is supported, image upload controls are shown
4. Keypad monitoring:
   - Press keys to update the persistent 3x3 + 2 widget
   - `Clear Keys` resets displayed state
5. Brightness control:
   - Use the slider or numeric field (`0..100`)
   - Click `Apply Brightness`
   - Click `Refresh` to read current value from device
6. Contextual display image upload:
   - Select an image file (`PNG`, `JPEG`, `WEBP`, `BMP`)
   - Pick an upload mode:
     - `Update one key` and choose key `1..9`
     - `Apply same image to all 9 keys`
     - `Map image over full keypad display`
   - Click `Upload Image`

## Notes

- The app now supports mixed feature availability per device.
- Devices are connectable if they expose at least one of `0x4610`, `0x1B04`, `0x8040`, or `0x19A1`.

## Troubleshooting

### No devices in list

- Re-run `Scan / Grant Devices`
- Confirm the device is connected and authorized in browser settings

### Keypad widget does not update

- Verify keys are being diverted (Feature `0x1B04`) when available
- On unsupported `0x1B04` devices, only raw report `0x13` events are used

### Brightness controls are hidden

- The connected device does not expose Feature `0x8040`

### Contextual display controls are hidden

- The connected device does not expose Feature `0x19A1`

### Roller monitor does not appear

- The connected device does not expose Feature `0x4610`
