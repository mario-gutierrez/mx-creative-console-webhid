import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const wsUrl = process.argv[2] || 'ws://localhost:8787';
const command = process.argv[3] || 'help';

function toBase64DataUri(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeByExt = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp'
    };

    const mime = mimeByExt[ext] || 'application/octet-stream';
    const bytes = fs.readFileSync(filePath);
    return `data:${mime};base64,${bytes.toString('base64')}`;
}

function printUsage() {
    console.log('Usage:');
    console.log('  node sample-cli/brightness-and-image.js ws://localhost:8787 brightness 60');
    console.log('  node sample-cli/brightness-and-image.js ws://localhost:8787 image ./image.jpg single 1');
    console.log('  node sample-cli/brightness-and-image.js ws://localhost:8787 image ./image.jpg all');
    console.log('  node sample-cli/brightness-and-image.js ws://localhost:8787 image ./image.jpg full');
}

const ws = new WebSocket(wsUrl);

ws.on('open', () => {
    if (command === 'brightness') {
        const percent = Number(process.argv[4]);
        ws.send(JSON.stringify({ requestId: 'brightness', action: 'setBrightness', percent }));
        return;
    }

    if (command === 'image') {
        const filePath = process.argv[4];
        const mode = process.argv[5] || 'single';
        const keyNumber = Number(process.argv[6] || 1);

        if (!filePath) {
            printUsage();
            ws.close();
            return;
        }

        const imageBase64 = toBase64DataUri(path.resolve(process.cwd(), filePath));
        ws.send(JSON.stringify({
            requestId: 'image',
            action: 'setImage',
            mode,
            keyNumber,
            imageBase64
        }));
        return;
    }

    printUsage();
    ws.close();
});

ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    console.log(JSON.stringify(msg, null, 2));

    if (msg.type === 'response') {
        ws.close();
    }
});

ws.on('error', (error) => {
    console.error(error.message);
});
