const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const brightnessEl = document.getElementById('brightnessValue');
const brightnessSlider = document.getElementById('brightnessSlider');
const fileInput = document.getElementById('fileInput');
const modeSelect = document.getElementById('modeSelect');
const keySelect = document.getElementById('keySelect');

let ws = null;
let requestCounter = 0;

function logLine(message) {
    const now = new Date().toLocaleTimeString();
    logEl.textContent += `[${now}] ${message}\n`;
    logEl.scrollTop = logEl.scrollHeight;
}

function updateStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.style.background = isError ? '#ffdada' : '#dceff8';
}

function nextRequestId() {
    requestCounter += 1;
    return `req-${requestCounter}`;
}

async function fileToDataUri(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    const base64 = btoa(binary);
    return `data:${file.type || 'application/octet-stream'};base64,${base64}`;
}

async function connect() {
    const config = await fetch('/api/config').then((res) => res.json());
    ws = new WebSocket(`ws://localhost:${config.websocketPort}`);

    ws.addEventListener('open', () => {
        updateStatus('Connected to provider.');
        logLine('WebSocket connected.');
        ws.send(JSON.stringify({ requestId: nextRequestId(), action: 'getState' }));
    });

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'status') {
            updateStatus(msg.message, Boolean(msg.isError));
            logLine(`STATUS: ${msg.message}`);
            return;
        }

        if (msg.type === 'event') {
            if (msg.event === 'brightnessChanged' && msg.data) {
                brightnessEl.textContent = String(msg.data.percent);
                brightnessSlider.value = String(msg.data.percent);
            }

            logLine(`${msg.event}: ${JSON.stringify(msg.data)}`);
            return;
        }

        if (msg.type === 'response') {
            if (msg.ok) {
                logLine(`RESPONSE ${msg.requestId || '-'}: ${JSON.stringify(msg.data)}`);
            } else {
                updateStatus(msg.error || 'Request failed', true);
                logLine(`ERROR ${msg.requestId || '-'}: ${msg.error}`);
            }
            return;
        }

        if (msg.type === 'state') {
            logLine(`STATE: ${JSON.stringify(msg.state)}`);
        }
    });

    ws.addEventListener('error', () => {
        updateStatus('WebSocket error. Is the provider running?', true);
    });

    ws.addEventListener('close', () => {
        updateStatus('Disconnected.', true);
        logLine('WebSocket closed.');
    });
}

document.getElementById('refreshStateBtn').addEventListener('click', () => {
    ws.send(JSON.stringify({ requestId: nextRequestId(), action: 'getState' }));
});

document.getElementById('setRollerDivertedBtn').addEventListener('click', () => {
    ws.send(JSON.stringify({ requestId: nextRequestId(), action: 'setRollerDiverted', enabled: true }));
});

document.getElementById('setBrightnessBtn').addEventListener('click', () => {
    ws.send(JSON.stringify({ requestId: nextRequestId(), action: 'setBrightness', percent: Number(brightnessSlider.value) }));
});

document.getElementById('uploadBtn').addEventListener('click', async () => {
    try {
        const file = fileInput.files?.[0];
        if (!file) {
            updateStatus('Select an image first.', true);
            return;
        }

        const imageBase64 = await fileToDataUri(file);
        ws.send(JSON.stringify({
            requestId: nextRequestId(),
            action: 'setImage',
            mode: modeSelect.value,
            keyNumber: Number(keySelect.value),
            imageBase64
        }));
    } catch (error) {
        updateStatus(error.message, true);
    }
});

connect().catch((error) => {
    updateStatus(error.message, true);
});
