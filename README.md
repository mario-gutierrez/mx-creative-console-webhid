# MX Creative Console WebHID

A lightweight, zero-dependency WebHID library for communicating with the **Logitech MX Creative Console** (Keypad) directly from the browser.

This project allows you to capture key events and render images to the device's LCD buttons without requiring official drivers or background software.

You can experience the library in action directly in your browser via the hosted GitHub Pages demos:

- [Main demo](https://mario-gutierrez.github.io/mx-creative-console-webhid/app/)
- [Image loader](https://mario-gutierrez.github.io/mx-creative-console-webhid/app/mosaic.html)

## 🚀 Features

- **Plug & Play:** Uses the browser's native WebHID API.
- **Input Handling:** Event-based listeners for `keydown` and `keyup` on all 9 grid buttons and the 2 paging buttons.
- **LCD Control:** Helper methods to render images (JPEG Blobs) to the 9 programmable LCD keys.
- **Image Slicing:** Includes a "Mosaic" demo that intelligently crops and slices a single image to display across the entire 3x3 keypad grid.

## 📦 File Structure

- `app/mx-creative-console.js`: The core library handling HID communication and packet generation.
- `app/index.html`: Basic demo showing connection handling and random color generation.
- `app/mosaic.html`: Advanced demo that allows users to upload an image and slice it across the keypad.

## 💻 Usage

To use the library, import the `MXCreativeConsole` class. Note that because this uses WebHID, it requires a secure context (HTTPS or localhost) and a Chromium-based browser (Chrome, Edge).

### Basic Implementation

```javascript
import { MXCreativeConsole } from './mx-creative-console.js';

const mx = new MXCreativeConsole();

// 1. Listen for connection events
mx.addEventListener('connected', (e) => {
    console.log(`Device connected: ${e.detail.device.productName}`);
});

// 2. Handle Key Presses (Keys 0-8 are Grid, 9-10 are Page buttons)
mx.addEventListener('keydown', (e) => {
    console.log(`Key Pressed: ${e.detail.key}`);
});

mx.addEventListener('keyup', (e) => {
    console.log(`Key Released: ${e.detail.key}`);
});

// 3. Initiate Connection (Must be triggered by user gesture, e.g., button click)
document.getElementById('connect-btn').addEventListener('click', async () => {
    try {
        await mx.connect();
    } catch (err) {
        console.error("Connection failed", err);
    }
});

// 4. Update an LCD Button Image
// The library expects a JPEG Blob or Uint8Array
async function updateButtonToRed(keyIndex) {
    const canvas = document.createElement('canvas');
    canvas.width = 118; // Native LCD size
    canvas.height = 118;
    const ctx = canvas.getContext('2d');
    
    // Draw something
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 118, 118);
    
    // Convert to Blob and send to device
    canvas.toBlob((blob) => {
        mx.setKeyImage(keyIndex, blob);
    }, 'image/jpeg', 0.9);
}
```

## 🏃 Running the Demos Locally

Since this project uses ES modules, you cannot run it by simply opening the HTML files in a browser. You must serve them via a local web server.

```bash
# Example using Python
python3 -m http.server 8000

# OR using Node/npx
npx serve .
```

Open `http://localhost:8000/app/index.html` in Chrome or Edge.
