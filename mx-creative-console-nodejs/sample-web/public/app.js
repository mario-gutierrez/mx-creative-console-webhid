import { MXCreativeConsoleNodeClient } from '/mxCreativeConsoleNodeClient.js';

const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const brightnessEl = document.getElementById('brightnessValue');
const brightnessSlider = document.getElementById('brightnessSlider');
const fileInput = document.getElementById('fileInput');
const modeSelect = document.getElementById('modeSelect');
const keySelect = document.getElementById('keySelect');

function logLine(message) {
    const now = new Date().toLocaleTimeString();
    logEl.textContent += `[${now}] ${message}\n`;
    logEl.scrollTop = logEl.scrollHeight;
}

function updateStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.style.background = isError ? '#ffdada' : '#dceff8';
}

async function main() {
    const config = await fetch('/api/config').then((res) => res.json());

    const client = new MXCreativeConsoleNodeClient({
        url: `ws://localhost:${config.websocketPort}`,
        debug: false
    });

    // ── Status & connection events ──────────────────────────────────────────
    client.on('status', ({ message, isError }) => {
        updateStatus(message, isError);
        logLine(`STATUS: ${message}`);
    });
    client.on('connected', () => {
        updateStatus('Connected to provider.');
        logLine('Connected.');
    });
    client.on('disconnected', ({ code }) => {
        updateStatus('Disconnected. Reconnecting…', true);
        logLine(`Disconnected (code ${code}).`);
    });
    client.on('error', (err) => {
        updateStatus(`Connection error: ${err.message}`, true);
    });

    // ── Device lifecycle events ─────────────────────────────────────────────
    client.on('stateChanged', (state) => logLine(`stateChanged: ${JSON.stringify(state)}`));
    client.on('roleConnected', (data) => logLine(`roleConnected: ${JSON.stringify(data)}`));
    client.on('roleDisconnected', (data) => logLine(`roleDisconnected: ${JSON.stringify(data)}`));

    // ── Hardware events ─────────────────────────────────────────────────────
    client.on('keypadKeysChanged', (data) => logLine(`keypadKeysChanged: ${JSON.stringify(data)}`));
    client.on('dialpadKeysChanged', (data) => logLine(`dialpadKeysChanged: ${JSON.stringify(data)}`));
    client.on('rollerEvent', (data) => logLine(`rollerEvent: ${JSON.stringify(data)}`));

    client.on('brightnessChanged', ({ percent }) => {
        brightnessEl.textContent = String(percent);
        brightnessSlider.value = String(percent);
        logLine(`brightnessChanged: ${percent}%`);
    });

    client.on('imageUploadComplete', (data) => logLine(`imageUploadComplete: ${JSON.stringify(data)}`));

    // ── Connect ─────────────────────────────────────────────────────────────
    await client.connect();
    logLine(`state: ${JSON.stringify(client.getConnectionState())}`);

    // ── Button handlers ─────────────────────────────────────────────────────
    document.getElementById('refreshStateBtn').addEventListener('click', async () => {
        try {
            await client.scanAuthorizedDevices();
            logLine(`state: ${JSON.stringify(client.getConnectionState())}`);
        } catch (err) {
            updateStatus(err.message, true);
        }
    });

    document.getElementById('setRollerDivertedBtn').addEventListener('click', async () => {
        try {
            await client.setRollerDiverted(true);
        } catch (err) {
            updateStatus(err.message, true);
        }
    });

    document.getElementById('setBrightnessBtn').addEventListener('click', async () => {
        try {
            await client.setBrightnessPercent(Number(brightnessSlider.value));
        } catch (err) {
            updateStatus(err.message, true);
        }
    });

    document.getElementById('uploadBtn').addEventListener('click', async () => {
        try {
            const file = fileInput.files?.[0];
            if (!file) {
                updateStatus('Select an image first.', true);
                return;
            }
            await client.uploadContextualDisplayImage(file, {
                mode: modeSelect.value,
                keyNumber: Number(keySelect.value)
            });
        } catch (err) {
            updateStatus(err.message, true);
        }
    });
}

main().catch((err) => {
    document.getElementById('status').textContent = `Failed to start: ${err.message}`;
    document.getElementById('status').style.background = '#ffdada';
});
