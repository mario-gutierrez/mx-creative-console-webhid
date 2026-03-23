import { MXCreativeConsoleNodeClient } from '/mxCreativeConsoleNodeClient.js';

const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const previewVideo = document.getElementById('previewVideo');
const videoInput = document.getElementById('videoInput');
const modeSelect = document.getElementById('modeSelect');
const keySelect = document.getElementById('keySelect');
const fpsInput = document.getElementById('fpsInput');
const qualityInput = document.getElementById('qualityInput');
const fpsValueEl = document.getElementById('fpsValue');
const uploadedFramesEl = document.getElementById('uploadedFrames');
const lastUploadMsEl = document.getElementById('lastUploadMs');
const deviceStateEl = document.getElementById('deviceState');
const connectBtn = document.getElementById('connectBtn');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');

const frameCanvas = document.createElement('canvas');
const frameContext = frameCanvas.getContext('2d', { alpha: false });

let client;
let objectUrl = null;
let streamActive = false;
let frameRequestHandle = null;
let uploadedFrames = 0;
let uploadInFlight = false;
let lastFrameSentAt = 0;

function logLine(message) {
    const now = new Date().toLocaleTimeString();
    logEl.textContent += `[${now}] ${message}\n`;
    logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
}

function updateMetrics({ lastUploadMs } = {}) {
    fpsValueEl.textContent = String(Number(fpsInput.value));
    uploadedFramesEl.textContent = String(uploadedFrames);
    if (typeof lastUploadMs === 'number') {
        lastUploadMsEl.textContent = `${Math.round(lastUploadMs)} ms`;
    } else if (!uploadedFrames) {
        lastUploadMsEl.textContent = '-';
    }

    const state = client?.getConnectionState();
    if (!state?.keypadConnected) {
        deviceStateEl.textContent = 'Keypad offline';
        return;
    }
    if (!state.features?.keypad?.contextualDisplay) {
        deviceStateEl.textContent = 'Display unavailable';
        return;
    }
    deviceStateEl.textContent = streamActive ? 'Streaming' : 'Ready';
}

function currentUploadOptions() {
    return {
        mode: modeSelect.value,
        keyNumber: Number(keySelect.value)
    };
}

function targetFrameSize(mode) {
    if (mode === 'full') {
        return { width: 457, height: 440 };
    }
    return { width: 118, height: 118 };
}

function syncKeySelectorState() {
    keySelect.disabled = modeSelect.value !== 'single';
}

function getFrameIntervalMs() {
    return 1000 / Math.max(1, Number(fpsInput.value));
}

function drawCoverFrame(video, width, height) {
    const videoWidth = video.videoWidth || width;
    const videoHeight = video.videoHeight || height;
    const scale = Math.max(width / videoWidth, height / videoHeight);
    const drawWidth = videoWidth * scale;
    const drawHeight = videoHeight * scale;
    const offsetX = (width - drawWidth) / 2;
    const offsetY = (height - drawHeight) / 2;

    frameCanvas.width = width;
    frameCanvas.height = height;
    frameContext.fillStyle = '#000';
    frameContext.fillRect(0, 0, width, height);
    frameContext.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Failed to encode the current video frame.'));
                return;
            }
            resolve(blob);
        }, type, quality);
    });
}

async function uploadCurrentFrame() {
    if (!client) {
        throw new Error('Client is not ready.');
    }

    const state = client.getConnectionState();
    if (!state.keypadConnected) {
        throw new Error('Keypad is not connected.');
    }
    if (!state.features?.keypad?.contextualDisplay) {
        throw new Error('Contextual display feature is not available.');
    }

    const { mode, keyNumber } = currentUploadOptions();
    const { width, height } = targetFrameSize(mode);
    const quality = Number(qualityInput.value);

    drawCoverFrame(previewVideo, width, height);
    const frameBlob = await canvasToBlob(frameCanvas, 'image/jpeg', quality);
    const startedAt = performance.now();

    await client.uploadContextualDisplayImage(frameBlob, { mode, keyNumber });

    uploadedFrames += 1;
    lastFrameSentAt = performance.now();
    updateMetrics({ lastUploadMs: lastFrameSentAt - startedAt });
}

function cancelScheduledFrame() {
    if (typeof frameRequestHandle === 'number') {
        if (typeof previewVideo.cancelVideoFrameCallback === 'function') {
            previewVideo.cancelVideoFrameCallback(frameRequestHandle);
        } else {
            clearTimeout(frameRequestHandle);
        }
    }
    frameRequestHandle = null;
}

function stopStreaming(reason, isError = false) {
    if (!streamActive && !reason) return;

    streamActive = false;
    uploadInFlight = false;
    cancelScheduledFrame();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateMetrics();

    if (reason) {
        setStatus(reason, isError);
        logLine(reason);
    }
}

async function handleFrameTick(now) {
    if (!streamActive) return;

    if (previewVideo.paused || previewVideo.ended) {
        stopStreaming(previewVideo.ended ? 'Video playback ended.' : 'Video playback paused.');
        return;
    }

    if (uploadInFlight) {
        scheduleNextFrame();
        return;
    }

    const intervalMs = getFrameIntervalMs();
    if (now - lastFrameSentAt < intervalMs) {
        scheduleNextFrame();
        return;
    }

    uploadInFlight = true;

    try {
        await uploadCurrentFrame();
    } catch (error) {
        setStatus(error.message, true);
        logLine(`ERROR: ${error.message}`);
        stopStreaming('Device playback stopped.', true);
        return;
    } finally {
        uploadInFlight = false;
    }

    scheduleNextFrame();
}

function scheduleNextFrame() {
    if (!streamActive) return;

    if (typeof previewVideo.requestVideoFrameCallback === 'function') {
        frameRequestHandle = previewVideo.requestVideoFrameCallback((now) => {
            frameRequestHandle = null;
            handleFrameTick(now);
        });
        return;
    }

    frameRequestHandle = window.setTimeout(() => {
        frameRequestHandle = null;
        handleFrameTick(performance.now());
    }, 16);
}

async function refreshState() {
    await client.scanAuthorizedDevices();
    updateMetrics();
    const state = client.getConnectionState();
    if (state.keypadConnected && state.features?.keypad?.contextualDisplay) {
        setStatus('Provider connected. Keypad display is ready.');
        return;
    }
    setStatus('Provider connected, but the keypad display is not available yet.', true);
}

function disposeVideoUrl() {
    if (!objectUrl) return;
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
}

async function startStreaming() {
    if (!videoInput.files?.[0]) {
        setStatus('Select a local video file first.', true);
        return;
    }

    await refreshState();

    const state = client.getConnectionState();
    if (!state.keypadConnected || !state.features?.keypad?.contextualDisplay) {
        setStatus('Keypad display is not available. Start the provider and connect the keypad first.', true);
        return;
    }

    if (previewVideo.readyState < 2) {
        await new Promise((resolve) => {
            previewVideo.addEventListener('loadeddata', resolve, { once: true });
        });
    }

    uploadedFrames = 0;
    lastFrameSentAt = 0;
    streamActive = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    updateMetrics();

    await previewVideo.play();
    setStatus('Streaming frames to the keypad display...');
    logLine(`START: mode=${modeSelect.value} fps=${fpsInput.value} quality=${qualityInput.value}`);
    scheduleNextFrame();
}

async function main() {
    if (!frameContext) {
        throw new Error('Canvas 2D context is not available in this browser.');
    }

    const config = await fetch('/api/config').then((response) => response.json());

    client = new MXCreativeConsoleNodeClient({
        url: `ws://localhost:${config.websocketPort}`,
        debug: false
    });

    client.on('status', ({ message, isError }) => {
        setStatus(message, isError);
        logLine(`STATUS: ${message}`);
    });

    client.on('connected', () => {
        logLine('Connected to provider.');
    });

    client.on('disconnected', ({ code, reason }) => {
        setStatus(`Disconnected from provider (code ${code}${reason ? `, ${reason}` : ''}).`, true);
        logLine(`DISCONNECTED: code=${code} reason=${reason || 'n/a'}`);
        stopStreaming('Device playback stopped after disconnect.', true);
    });

    client.on('stateChanged', () => {
        updateMetrics();
    });

    client.on('imageUploadComplete', (data) => {
        logLine(`UPLOAD: ${JSON.stringify(data)}`);
    });

    syncKeySelectorState();
    updateMetrics();

    modeSelect.addEventListener('change', syncKeySelectorState);
    fpsInput.addEventListener('input', () => updateMetrics());
    qualityInput.addEventListener('input', () => updateMetrics());

    videoInput.addEventListener('change', () => {
        stopStreaming();
        disposeVideoUrl();

        const file = videoInput.files?.[0];
        if (!file) {
            previewVideo.removeAttribute('src');
            previewVideo.load();
            setStatus('Select a video file to prepare playback.');
            return;
        }

        objectUrl = URL.createObjectURL(file);
        previewVideo.src = objectUrl;
        previewVideo.currentTime = 0;
        previewVideo.load();
        setStatus(`Loaded video: ${file.name}`);
        logLine(`VIDEO: ${file.name}`);
    });

    previewVideo.addEventListener('pause', () => {
        if (streamActive && !previewVideo.ended) {
            stopStreaming('Device playback stopped because the video was paused.');
        }
    });

    previewVideo.addEventListener('ended', () => {
        if (streamActive) {
            stopStreaming('Video playback ended.');
        }
    });

    connectBtn.addEventListener('click', async () => {
        try {
            await refreshState();
        } catch (error) {
            setStatus(error.message, true);
            logLine(`ERROR: ${error.message}`);
        }
    });

    startBtn.addEventListener('click', async () => {
        try {
            await startStreaming();
        } catch (error) {
            setStatus(error.message, true);
            logLine(`ERROR: ${error.message}`);
            stopStreaming('Device playback stopped.', true);
        }
    });

    stopBtn.addEventListener('click', () => {
        previewVideo.pause();
        stopStreaming('Device playback stopped by user.');
    });

    await client.connect();
    await refreshState();
}

window.addEventListener('beforeunload', () => {
    stopStreaming();
    disposeVideoUrl();
});

main().catch((error) => {
    setStatus(`Failed to start: ${error.message}`, true);
    logLine(`ERROR: ${error.message}`);
});
