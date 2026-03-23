# MX Creative Console Node.js Provider — WebSocket API

The provider exposes a JSON-over-WebSocket API on `ws://localhost:8787` (port configurable in `config.json`).

All messages are UTF-8 JSON objects. There are two directions:

- **Client → Provider** — _requests_ (the client sends an action and expects a `response`)
- **Provider → Client** — _push messages_ (unsolicited `status`, `state`, and `event` messages) plus `response` replies

---

## Table of contents

1. [Connection](#1-connection)
2. [Client → Provider — requests](#2-client--provider--requests)
   - [ping](#ping)
   - [getState](#getstate)
   - [refreshBrightness](#refreshbrightness)
   - [setBrightness](#setbrightness)
   - [setRollerDiverted](#setrollerdiverted)
   - [setImage](#setimage)
3. [Provider → Client — push messages](#3-provider--client--push-messages)
   - [status](#status)
   - [state](#state)
   - [event — roleConnected](#event--roleconnected)
   - [event — roleDisconnected](#event--roledisconnected)
   - [event — stateChanged](#event--statechanged)
   - [event — keypadKeysChanged](#event--keypadkeyschanged)
   - [event — dialpadKeysChanged](#event--dialpadkeyschanged)
   - [event — rollerEvent](#event--rollerevent)
   - [event — rollerModeChanged](#event--rollermodechanged)
   - [event — brightnessChanged](#event--brightnesschanged)
   - [event — imageUploadComplete](#event--imageuploadcomplete)
4. [Response envelope](#4-response-envelope)
5. [Error envelope](#5-error-envelope)
6. [Shared type reference](#6-shared-type-reference)

---

## 1. Connection

When a client connects the provider immediately sends one [`state`](#state) message containing the current connection state. No authentication is required.

```
ws://localhost:8787
```

---

## 2. Client → Provider — requests

Every request may include an optional `requestId` field. When present it is echoed back in the corresponding [`response`](#4-response-envelope) so clients can correlate replies to pending calls.

```jsonc
{
  "requestId": "any-string-or-number",  // optional
  "action": "<action-name>",
  // ...action-specific fields
}
```

---

### ping

Liveness check with no side effects.

**Request**

```json
{
  "requestId": "p1",
  "action": "ping"
}
```

**Response `data`**

```json
{ "pong": true }
```

---

### getState

Returns the full current connection state snapshot.

**Request**

```json
{
  "requestId": "s1",
  "action": "getState"
}
```

**Response `data`** — see [`ConnectionState`](#connectionstate).

---

### refreshBrightness

Reads the current brightness from the keypad hardware and emits a [`brightnessChanged`](#event--brightnesschanged) event in addition to the response.

**Request**

```json
{
  "requestId": "b1",
  "action": "refreshBrightness"
}
```

**Response `data`**

```jsonc
{
  "raw": 80,      // raw device brightness value
  "percent": 80   // 0–100
}
```

Returns `null` data if brightness feature is unavailable.

---

### setBrightness

Sets the keypad display brightness. Also emits a [`brightnessChanged`](#event--brightnesschanged) event.

**Request**

| Field       | Type   | Required | Description           |
|-------------|--------|----------|-----------------------|
| `action`    | string | ✓        | `"setBrightness"`     |
| `percent`   | number | ✓        | Target brightness, `0`–`100` |

```json
{
  "requestId": "b2",
  "action": "setBrightness",
  "percent": 60
}
```

**Response `data`**

```jsonc
{
  "raw": 60,
  "percent": 60
}
```

**Error conditions**

- `"Brightness feature is unavailable."` — keypad not connected or feature not initialised.

---

### setRollerDiverted

Switches the dial roller(s) on the MX Dialpad between **native** (OS scroll) and **diverted** (provider reports raw delta events) reporting modes.

**Request**

| Field     | Type    | Required | Description |
|-----------|---------|----------|-------------|
| `action`  | string  | ✓        | `"setRollerDiverted"` |
| `enabled` | boolean | ✓        | `true` = diverted mode, `false` = native mode |

```json
{
  "requestId": "r1",
  "action": "setRollerDiverted",
  "enabled": true
}
```

**Response `data`**

```json
{ "enabled": true }
```

**Error conditions**

- `"Multi-roller feature is unavailable."` — dialpad not connected or feature not initialised.

---

### setImage

Uploads an image to one or more key displays on the MX Creative Keypad. The image is encoded server-side (JPEG preferred, RGB888 fallback) before being sent to the hardware. Also emits an [`imageUploadComplete`](#event--imageuploadcomplete) event.

**Request**

| Field        | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `action`     | string | ✓        | `"setImage"` |
| `imageBase64`| string | ✓        | Base-64 encoded image, optionally prefixed with a data-URI header (e.g. `data:image/png;base64,...`). Supported formats: JPEG, PNG, WebP, BMP. |
| `mode`       | string | ✓        | `"single"` \| `"all"` \| `"full"` (see below) |
| `keyNumber`  | number | ✗        | Key index `1`–`9`. Only used when `mode` is `"single"`. Defaults to `1`. |

#### `mode` values

| Value      | Description |
|------------|-------------|
| `"single"` | Upload to one specific key (`keyNumber`). The image is cropped/scaled to 118×118 px. |
| `"all"`    | Scale the image to 118×118 px and apply the same image to all 9 keys. |
| `"full"`   | Scale the image to the full display resolution (457×440 px) and send it as a single framebuffer update. |

```json
{
  "requestId": "img-1",
  "action": "setImage",
  "mode": "single",
  "keyNumber": 3,
  "imageBase64": "data:image/jpeg;base64,/9j/4AAQSkZJRgAB..."
}
```

**Response `data`** — varies by mode

`"single"`:

```json
{ "mode": "single", "keyNumber": 3 }
```

`"all"`:

```json
{ "mode": "all" }
```

`"full"`:

```json
{ "mode": "full" }
```

**Error conditions**

- `"Feature 0x19A1 is not available on this device."` — keypad not connected or display feature not initialised.
- `"keyNumber must be between 1 and 9 for single mode."` — invalid `keyNumber`.
- `"imageBase64 is required"` — missing or empty base-64 string.
- `"Could not encode image under device max image size with supported formats."` — image could not be compressed to fit within the 300 KB device limit.

---

## 3. Provider → Client — push messages

Push messages are sent to **all connected clients** without any prior request (except `response` which is targeted at the requesting socket).

All push messages have a top-level `type` field that identifies the message category.

---

### status

Emitted whenever the provider logs a human-readable status or error message (e.g. device connecting/connected/failed).

```jsonc
{
  "type": "status",
  "message": "keypad connected.",
  "isError": false
}
```

| Field     | Type    | Description |
|-----------|---------|-------------|
| `message` | string  | Human-readable description. |
| `isError` | boolean | `true` if this is an error condition. |

---

### state

Sent automatically on every new client connection and after each device poll cycle. Contains the full [`ConnectionState`](#connectionstate).

```json
{
  "type": "state",
  "state": { }
}
```

---

### event — roleConnected

Emitted when a device (keypad or dialpad) successfully connects and initialises.

```jsonc
{
  "type": "event",
  "event": "roleConnected",
  "data": {
    "role": "keypad",
    "path": "\\\\?\\HID#VID_046D...",
    "productId": 49972,
    "productName": "MX Creative Keypad",
    "friendlyName": "MX Creative Keypad"
  }
}
```

| Field          | Type   | Description |
|----------------|--------|-------------|
| `role`         | string | `"keypad"` or `"dialpad"` |
| `path`         | string | OS HID device path |
| `productId`    | number | USB product ID (decimal) |
| `productName`  | string | Product name from USB descriptor |
| `friendlyName` | string | Name from HID++ Feature 0x0007, falls back to `productName` |

---

### event — roleDisconnected

Emitted when a device disconnects (either by USB unplug or HID transport error).

```jsonc
{
  "type": "event",
  "event": "roleDisconnected",
  "data": {
    "role": "keypad",
    "path": "\\\\?\\HID#VID_046D...",
    "disconnectedByScan": true
  }
}
```

| Field                | Type    | Description |
|----------------------|---------|-------------|
| `role`               | string  | `"keypad"` or `"dialpad"` |
| `path`               | string  | OS HID device path that was in use |
| `disconnectedByScan` | boolean | `true` if the device path vanished during a scan; `false` if disconnected programmatically |

---

### event — stateChanged

Emitted after every connect or disconnect to signal that the connection state snapshot has changed. The new state is not inlined; send a [`getState`](#getstate) request or wait for the next [`state`](#state) push message.

```json
{
  "type": "event",
  "event": "stateChanged",
  "data": { }
}
```

`data` is the full [`ConnectionState`](#connectionstate) object.

---

### event — keypadKeysChanged

Emitted whenever the set of currently-pressed keys on the MX Creative Keypad changes.

```jsonc
{
  "type": "event",
  "event": "keypadKeysChanged",
  "data": {
    "source": "raw",
    "activeControlIds": [1, 2],
    "activeLabels": ["1", "2"]
  }
}
```

| Field             | Type     | Description |
|-------------------|----------|-------------|
| `source`          | string   | `"raw"` — triggered by VLP report 0x13 (keys 1–9); `"diverted"` — triggered by HID++ Feature 1B04 (PREV/NEXT) |
| `activeControlIds`| number[] | Control IDs of all keys currently held down. See [Keypad control IDs](#keypad-control-ids). |
| `activeLabels`    | string[] | Corresponding readable labels. |

---

### event — dialpadKeysChanged

Emitted whenever the set of currently-pressed buttons on the MX Dialpad changes.

```jsonc
{
  "type": "event",
  "event": "dialpadKeysChanged",
  "data": {
    "source": "diverted",
    "activeControlIds": [83],
    "activeLabels": ["D1"]
  }
}
```

| Field             | Type     | Description |
|-------------------|----------|-------------|
| `source`          | string   | `"raw"` or `"diverted"` |
| `activeControlIds`| number[] | Control IDs of all buttons currently held. See [Dialpad control IDs](#dialpad-control-ids). |
| `activeLabels`    | string[] | Corresponding readable labels. |

---

### event — rollerEvent

Emitted each time a dial roller on the MX Dialpad rotates. Only fires when the roller is in **diverted** mode (see [`setRollerDiverted`](#setrollerdiverted)).

```jsonc
{
  "type": "event",
  "event": "rollerEvent",
  "data": {
    "rollerId": 0,
    "delta": -3,
    "timestamp": 123456789,
    "eventCount": 12,
    "snapshot": [
      {
        "rollerId": 0,
        "available": true,
        "isChanged": true,
        "directionClass": "down",
        "progress": 0.42,
        "position": 17,
        "incrementsPerRotation": 40
      },
      {
        "rollerId": 1,
        "available": true,
        "isChanged": false,
        "directionClass": "idle",
        "progress": 0.0,
        "position": 0,
        "incrementsPerRotation": 180
      }
    ]
  }
}
```

| Field        | Type     | Description |
|--------------|----------|-------------|
| `rollerId`   | number   | `0` = outer ring, `1` = inner ring |
| `delta`      | number   | Signed rotation delta. Positive = clockwise (up), negative = counter-clockwise (down). |
| `timestamp`  | number   | Device timestamp in milliseconds (rolls over). |
| `eventCount` | number   | Cumulative count of rotation events since device connected. |
| `snapshot`   | object[] | Per-roller state array (always 2 entries, one per roller). See [`RollerSnapshot`](#rollersnapshot). |

---

### event — rollerModeChanged

Emitted immediately after [`setRollerDiverted`](#setrollerdiverted) succeeds.

```jsonc
{
  "type": "event",
  "event": "rollerModeChanged",
  "data": {
    "mode": 1,
    "modeName": "Diverted",
    "diverted": true
  }
}
```

| Field      | Type    | Description |
|------------|---------|-------------|
| `mode`     | number  | Raw mode value: `0` = Native, `1` = Diverted |
| `modeName` | string  | `"Native"` or `"Diverted"` |
| `diverted` | boolean | `true` when in diverted mode |

---

### event — brightnessChanged

Emitted after [`refreshBrightness`](#refreshbrightness), [`setBrightness`](#setbrightness), and on initial keypad connection.

```jsonc
{
  "type": "event",
  "event": "brightnessChanged",
  "data": {
    "raw": 80,
    "percent": 80
  }
}
```

| Field     | Type   | Description |
|-----------|--------|-------------|
| `raw`     | number | Raw device value (device-specific range from `brightnessInfo.minBrightness` to `brightnessInfo.maxBrightness`) |
| `percent` | number | Normalised `0`–`100` |

---

### event — imageUploadComplete

Emitted after [`setImage`](#setimage) finishes writing all packets to the device.

```jsonc
{
  "type": "event",
  "event": "imageUploadComplete",
  "data": {
    "mode": "single",
    "keyNumber": 3
  }
}
```

`keyNumber` is only present when `mode` is `"single"`.

---

## 4. Response envelope

Every action that triggers a response returns a message with `type: "response"`. Successful responses have `ok: true`; failures have `ok: false`.

**Success**

```jsonc
{
  "type": "response",
  "requestId": "img-1",   // echoed from request, or null
  "ok": true,
  "data": { }             // action-specific payload
}
```

**Failure**

```jsonc
{
  "type": "response",
  "requestId": "img-1",
  "ok": false,
  "error": "Feature 0x19A1 is not available on this device."
}
```

---

## 5. Error envelope

If the provider cannot parse incoming JSON it sends (without `requestId`):

```json
{
  "type": "error",
  "error": "Invalid JSON payload"
}
```

---

## 6. Shared type reference

### ConnectionState

Returned by [`getState`](#getstate), sent in [`state`](#state) push messages, and embedded in [`stateChanged`](#event--statechanged) events.

```jsonc
{
  "keypadConnected": true,
  "dialpadConnected": true,
  "features": {
    "keypad": {
      "specialKeys": true,       // HID++ Feature 1B04 (PREV/NEXT diversion)
      "brightness": true,        // HID++ Feature 8040
      "contextualDisplay": true  // HID++ Feature 19A1 (key images)
    },
    "dialpad": {
      "specialKeys": true,       // HID++ Feature 1B04
      "multiRoller": true        // HID++ Feature 4610
    }
  },
  "brightnessInfo": {
    "maxBrightness": 100,
    "steps": 101,
    "capabilities": 16,
    "minBrightness": 0
  },
  "contextualDisplayCaps": {
    "deviceScreenCount": 1,
    "maxImageSize": 307200,
    "maxImageFPS": 10,
    "deferrableDisplayUpdate": true,
    "rgb565": false,
    "rgb888": true,
    "jpeg": true,
    "calibrated": false,
    "origin": 0
  },
  "contextualDisplayInfo": {
    "displayShape": 0,
    "dimension": 0,
    "resHorizontal": 457,
    "resVertical": 440,
    "buttons": [
      { "shape": 1, "location": { "x": 23, "y": 6,   "w": 118, "h": 118 } },
      { "shape": 1, "location": { "x": 181, "y": 6,  "w": 118, "h": 118 } },
      { "shape": 1, "location": { "x": 339, "y": 6,  "w": 118, "h": 118 } },
      { "shape": 1, "location": { "x": 23, "y": 164, "w": 118, "h": 118 } },
      { "shape": 1, "location": { "x": 181, "y": 164,"w": 118, "h": 118 } },
      { "shape": 1, "location": { "x": 339, "y": 164,"w": 118, "h": 118 } },
      { "shape": 1, "location": { "x": 23, "y": 322, "w": 118, "h": 118 } },
      { "shape": 1, "location": { "x": 181, "y": 322,"w": 118, "h": 118 } },
      { "shape": 1, "location": { "x": 339, "y": 322,"w": 118, "h": 118 } }
    ],
    "visibleAreas": []
  },
  "rollerCapabilities": [
    {
      "rollerId": 0,
      "incrementsPerRotation": 40,
      "incrementsPerRatchet": 0,
      "lightbarId": 15,
      "timestampReport": 1
    },
    {
      "rollerId": 1,
      "incrementsPerRotation": 180,
      "incrementsPerRatchet": 0,
      "lightbarId": 15,
      "timestampReport": 1
    }
  ],
  "rollerEventCount": 0
}
```

`brightnessInfo`, `contextualDisplayCaps`, and `contextualDisplayInfo` are `null` when the keypad is not connected.  
`rollerCapabilities` is an empty array `[]` when the dialpad is not connected.

---

### RollerSnapshot

One element of the `snapshot` array inside a [`rollerEvent`](#event--rollerevent).

| Field                 | Type    | Description |
|-----------------------|---------|-------------|
| `rollerId`            | number  | `0` = outer ring, `1` = inner ring |
| `available`           | boolean | Whether the roller was detected on this device |
| `isChanged`           | boolean | `true` only for the roller that triggered this event |
| `directionClass`      | string  | `"up"` / `"down"` (only meaningful when `isChanged` is `true`); `"idle"` otherwise |
| `progress`            | number  | Current position as a fraction `0.0`–`1.0` of one full rotation |
| `position`            | number  | Current position in increments `0` to `incrementsPerRotation - 1` |
| `incrementsPerRotation` | number | Total increments for one full rotation of this roller |

---

### Keypad control IDs

| Label | Control ID (decimal) | Control ID (hex) |
|-------|---------------------|------------------|
| `1`   | 1   | `0x0001` |
| `2`   | 2   | `0x0002` |
| `3`   | 3   | `0x0003` |
| `4`   | 4   | `0x0004` |
| `5`   | 5   | `0x0005` |
| `6`   | 6   | `0x0006` |
| `7`   | 7   | `0x0007` |
| `8`   | 8   | `0x0008` |
| `9`   | 9   | `0x0009` |
| `PREV`| 417 | `0x01A1` |
| `NEXT`| 418 | `0x01A2` |

Keys 1–9 arrive via the raw VLP collection (`source: "raw"`).  
PREV and NEXT arrive via HID++ Feature 1B04 diversion (`source: "diverted"`).

---

### Dialpad control IDs

| Label | Control ID (decimal) | Control ID (hex) |
|-------|---------------------|------------------|
| `D1`  | 83  | `0x0053` |
| `D2`  | 86  | `0x0056` |
| `D3`  | 89  | `0x0059` |
| `D4`  | 90  | `0x005A` |
