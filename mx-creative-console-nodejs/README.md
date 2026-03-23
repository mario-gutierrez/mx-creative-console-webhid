# MX Creative Console Node.js Provider

Standalone Node.js application that runs locally, talks directly to MX Creative Console hardware, and exposes a WebSocket API for third-party integrations.

## What this app provides

- Headless API provider process for keypad and dialpad.
- Automatic device connect/disconnect handling.
- WebSocket endpoint (default `ws://localhost:8787`) configurable via `config.json`.
- Event streaming for:
  - Keypad key events
  - Dialpad key events
  - Dial roller events
- Commands for:
  - Brightness control
  - Contextual image upload with modes `single`, `all`, `full`
- Sample clients:
  - CLI event logger
  - CLI brightness/image sender
  - Web sample UI similar to `basic-events.html` and `brightness-and-image.html`

## Install

```bash
cd mx-creative-console-nodejs
npm install
```

## Configuration

Edit `config.json`:

```json
{
  "websocket": {
    "port": 8787
  },
  "provider": {
    "debug": true,
    "devicePollMs": 1000
  },
  "web": {
    "port": 8788
  }
}
```

## Run the headless provider

```bash
npm run provider
```

Optional custom config path:

```bash
node src/index.js ./config.json
```

## WebSocket API

All messages are JSON.

### Provider -> Client message types

- `status`
- `state`
- `event`
- `response`

### Client -> Provider actions

- `getState`
- `refreshBrightness`
- `setBrightness` with `percent`
- `setRollerDiverted` with `enabled`
- `setImage` with:
  - `imageBase64`
  - `mode`: `single` | `all` | `full`
  - `keyNumber` (used by `single`)

### Example set image request

```json
{
  "requestId": "img-1",
  "action": "setImage",
  "mode": "single",
  "keyNumber": 2,
  "imageBase64": "data:image/jpeg;base64,..."
}
```

## Sample clients

### 1) Basic events CLI

```bash
npm run sample:cli:events
```

Optional URL:

```bash
node sample-cli/basic-events.js ws://localhost:8787
```

### 2) Brightness + image CLI

Set brightness:

```bash
npm run sample:cli:brightness-image -- ws://localhost:8787 brightness 60
```

Upload one key:

```bash
npm run sample:cli:brightness-image -- ws://localhost:8787 image ./sample.jpg single 1
```

Upload all keys:

```bash
npm run sample:cli:brightness-image -- ws://localhost:8787 image ./sample.jpg all
```

Upload full display:

```bash
npm run sample:cli:brightness-image -- ws://localhost:8787 image ./sample.jpg full
```

### 3) Web sample

Start provider first, then:

```bash
npm run sample:web
```

Open `http://localhost:8788`.

## Notes

- This app uses `node-hid`, `ws`, and `sharp`.
- On Windows, running from a regular shell is usually enough for HID access.
- The provider is designed to continue running headlessly in the background.
