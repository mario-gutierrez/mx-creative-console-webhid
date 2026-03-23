/**
 * mxCreativeConsoleNodeClient.js
 *
 * Reusable JavaScript client for the mx-creative-console-nodejs WebSocket provider.
 *
 * Drop-in compatible with MXCreativeConsoleClient (WebHID-based).
 * A web application can switch between direct WebHID access and this provider-backed
 * client by swapping the import — event names, method signatures, and return shapes
 * are identical.
 *
 * Works in browsers (native WebSocket) and Node.js v22+ (built-in WebSocket).
 * For Node.js < 22, pass the 'ws' constructor via options.WebSocket:
 *
 *   import { WebSocket } from 'ws';
 *   const client = new MXCreativeConsoleNodeClient({ url: '...', WebSocket });
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REFERENCE IMPLEMENTATION — WEBSOCKET PROTOCOL DOCUMENTATION
 *  Use this as a specification guide for clients in C#, C++, Python, Unity, etc.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * SERVER:   ws://localhost:8787   (port configurable in provider config.json)
 * ENCODING: UTF-8 JSON
 * AUTH:     None
 *
 * ── CONNECTION LIFECYCLE ──────────────────────────────────────────────────────
 *
 *  1. Open a WebSocket connection to the server URL.
 *  2. The provider immediately pushes a full 'state' message (see below).
 *  3. Listen for push messages for every hardware event.
 *  4. Send request objects to issue commands (see ACTIONS).
 *  5. Reconnect after unexpected disconnects (recommended delay: 2 s).
 *
 * ── REQUEST ENVELOPE (Client → Provider) ─────────────────────────────────────
 *
 *  {
 *    "requestId": "<any string>",   // Optional. Echoed verbatim in the response.
 *    "action":    "<action-name>",  // Required. See ACTIONS below.
 *    ...                            // Action-specific fields.
 *  }
 *
 * ── RESPONSE ENVELOPE (Provider → Client) ────────────────────────────────────
 *
 *  {
 *    "type":      "response",
 *    "requestId": "<echoed>",  // null when requestId was omitted in the request.
 *    "ok":        true|false,
 *    "data":      <any>,       // Present when ok === true.
 *    "error":     "<string>"   // Present when ok === false.
 *  }
 *
 * ── PUSH MESSAGES (Provider → Client, unsolicited) ───────────────────────────
 *
 *  STATUS — Human-readable provider log line (device connecting, errors, etc.)
 *  {
 *    "type":    "status",
 *    "message": "<string>",
 *    "isError": true|false
 *  }
 *
 *  STATE SNAPSHOT — Sent immediately on every new connection and after each
 *  device poll cycle.
 *  {
 *    "type":  "state",
 *    "state": <ConnectionState>   // See ConnectionState shape below.
 *  }
 *
 *  EVENT — Hardware or lifecycle event.
 *  {
 *    "type":  "event",
 *    "event": "<event-name>",
 *    "data":  <object>
 *  }
 *
 * ── ACTIONS ──────────────────────────────────────────────────────────────────
 *
 *  ping
 *    Request:  { "action": "ping" }
 *    Response: { "pong": true }
 *
 *  getState
 *    Request:  { "action": "getState" }
 *    Response: <ConnectionState>
 *
 *  refreshBrightness
 *    Request:  { "action": "refreshBrightness" }
 *    Response: { "raw": <number>, "percent": <0-100> }
 *    Side effect: Emits a 'brightnessChanged' push event.
 *
 *  setBrightness
 *    Request:  { "action": "setBrightness", "percent": <0-100> }
 *    Response: { "raw": <number>, "percent": <0-100> }
 *    Side effect: Emits a 'brightnessChanged' push event.
 *
 *  setRollerDiverted
 *    Request:  { "action": "setRollerDiverted", "enabled": true|false }
 *    Response: { "enabled": true|false }
 *    Note: Must be enabled to receive 'rollerEvent' push messages.
 *          When disabled the OS receives native scroll events instead.
 *
 *  setImage
 *    Request:  {
 *      "action":      "setImage",
 *      "imageBase64": "<data-URI or raw base-64 string>",
 *      "mode":        "single" | "all" | "full",
 *      "keyNumber":   <1-9>    // Only used when mode === "single".
 *    }
 *    Response (single): { "mode": "single", "keyNumber": <n> }
 *    Response (all):    { "mode": "all" }
 *    Response (full):   { "mode": "full" }
 *    Notes:
 *      - Supported source formats: JPEG, PNG, WebP, BMP.
 *      - imageBase64 may include a data-URI prefix ("data:image/png;base64,…");
 *        the prefix is stripped server-side before decoding.
 *      - The provider encodes/compresses the image and transfers it to the device.
 *      - "single" targets one 118×118 px key LCD.
 *      - "all"    sends the image to all 9 key LCDs (118×118 px each).
 *      - "full"   sends a single 457×440 px framebuffer update.
 *    Error conditions:
 *      - "Feature 0x19A1 is not available on this device." — keypad not connected.
 *      - "keyNumber must be between 1 and 9 for single mode."
 *      - "imageBase64 is required"
 *      - "Could not encode image under device max image size with supported formats."
 *
 * ── PUSH EVENT TYPES ─────────────────────────────────────────────────────────
 *
 *  roleConnected
 *    { "role": "keypad"|"dialpad", "path": "<string>",
 *      "productId": <number>, "productName": "<string>", "friendlyName": "<string>" }
 *
 *  roleDisconnected
 *    { "role": "keypad"|"dialpad", "path": "<string>", "disconnectedByScan": <bool> }
 *
 *  stateChanged
 *    <ConnectionState>   — same shape as the getState response.
 *
 *  keypadKeysChanged  — Fires on every key-press or key-release on the keypad.
 *    {
 *      "source":          "raw" | "diverted",
 *      "activeControlIds": <number[]>,  // Control IDs of all currently-held keys.
 *      "activeLabels":     <string[]>   // Corresponding labels.
 *    }
 *    source "raw"      → triggered by VLP report 0x13 (keys 1–9)
 *    source "diverted" → triggered by HID++ Feature 1B04 (PREV / NEXT)
 *
 *  dialpadKeysChanged — Fires on every button-press or button-release on the dialpad.
 *    {
 *      "source":          "raw" | "diverted",
 *      "activeControlIds": <number[]>,
 *      "activeLabels":     <string[]>
 *    }
 *
 *  rollerEvent — Fires on every dial rotation (requires setRollerDiverted enabled).
 *    {
 *      "rollerId":   <number>,   // 0 or 1
 *      "delta":      <number>,   // Signed rotation increment (+/-)
 *      "timestamp":  <number>,   // Device timestamp (ms)
 *      "eventCount": <number>,   // Running total since provider start
 *      "snapshot":   <RollerSnapshot[]>
 *    }
 *
 *  rollerModeChanged
 *    { "mode": <number>, "modeName": "<string>", "diverted": <bool> }
 *
 *  brightnessChanged
 *    { "raw": <number>, "percent": <0-100> }
 *
 *  imageUploadComplete
 *    { "mode": "single"|"all"|"full", "keyNumber": <number|undefined> }
 *
 * ── ConnectionState SHAPE ─────────────────────────────────────────────────────
 *  {
 *    "keypadConnected":      <bool>,
 *    "dialpadConnected":     <bool>,
 *    "features": {
 *      "keypad":  { "specialKeys": <bool>, "brightness": <bool>, "contextualDisplay": <bool> },
 *      "dialpad": { "specialKeys": <bool>, "multiRoller": <bool> }
 *    },
 *    "brightnessInfo": {
 *      "minBrightness": <number>, "maxBrightness": <number>, "currentBrightness": <number>
 *    } | null,
 *    "contextualDisplayCaps": {
 *      "jpeg": <bool>, "rgb888": <bool>, "maxImageSize": <number>, "deviceScreenCount": <number>
 *    } | null,
 *    "contextualDisplayInfo": {
 *      "buttons": <ButtonInfo[]>, "resHorizontal": <number>, "resVertical": <number>
 *    } | null,
 *    "rollerCapabilities":   <RollerCapability[]>,
 *    "rollerEventCount":     <number>
 *  }
 *
 * ── RollerCapability SHAPE ────────────────────────────────────────────────────
 *  { "rollerId": <number>, "incrementsPerRotation": <number> }
 *
 * ── RollerSnapshot SHAPE ─────────────────────────────────────────────────────
 *  {
 *    "rollerId":              <number>,
 *    "available":             <bool>,
 *    "isChanged":             <bool>,
 *    "directionClass":        "up" | "down" | "idle",
 *    "progress":              <number>,  // 0–1 normalised roller position
 *    "position":              <number>,
 *    "incrementsPerRotation": <number>
 *  }
 *
 * ── CONTROL ID MAPS ──────────────────────────────────────────────────────────
 *
 *  KEYPAD_KEYS:
 *    0x0001 = "1",  0x0002 = "2",  0x0003 = "3",
 *    0x0004 = "4",  0x0005 = "5",  0x0006 = "6",
 *    0x0007 = "7",  0x0008 = "8",  0x0009 = "9",
 *    0x01A1 = "PREV", 0x01A2 = "NEXT"
 *
 *  DIALPAD_KEYS:
 *    0x0053 = "D1", 0x0056 = "D2", 0x0059 = "D3", 0x005A = "D4"
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared constants — identical to mxCreativeConsole.js for drop-in compatibility
// ─────────────────────────────────────────────────────────────────────────────

export const KEYPAD_KEYS = [
    { controlId: 0x0001, label: '1' },
    { controlId: 0x0002, label: '2' },
    { controlId: 0x0003, label: '3' },
    { controlId: 0x0004, label: '4' },
    { controlId: 0x0005, label: '5' },
    { controlId: 0x0006, label: '6' },
    { controlId: 0x0007, label: '7' },
    { controlId: 0x0008, label: '8' },
    { controlId: 0x0009, label: '9' },
    { controlId: 0x01a1, label: 'PREV' },
    { controlId: 0x01a2, label: 'NEXT' }
];

export const DIALPAD_KEYS = [
    { controlId: 0x0053, label: 'D1' },
    { controlId: 0x0056, label: 'D2' },
    { controlId: 0x0059, label: 'D3' },
    { controlId: 0x005a, label: 'D4' }
];

// ─────────────────────────────────────────────────────────────────────────────
// MXCreativeConsoleNodeClient
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WebSocket client for the mx-creative-console-nodejs provider.
 *
 * Emits the same events as MXCreativeConsoleClient (WebHID-based), so web
 * applications can switch between the two implementations with minimal changes.
 *
 * @example
 * // Browser — import and use like the WebHID version
 * import { MXCreativeConsoleNodeClient } from './mxCreativeConsoleNodeClient.js';
 *
 * const client = new MXCreativeConsoleNodeClient({ url: 'ws://localhost:8787' });
 * client.on('keypadKeysChanged', ({ activeLabels }) => console.log(activeLabels));
 * client.on('rollerEvent',       ({ rollerId, delta }) => console.log(rollerId, delta));
 * await client.connect();
 *
 * @example
 * // Node.js < v22 — supply the 'ws' WebSocket constructor
 * import { WebSocket } from 'ws';
 * import { MXCreativeConsoleNodeClient } from './mxCreativeConsoleNodeClient.js';
 *
 * const client = new MXCreativeConsoleNodeClient({ WebSocket });
 * await client.connect();
 * const state = client.getConnectionState();
 */
export class MXCreativeConsoleNodeClient {
    /**
     * @param {object}   [options]
     * @param {string}   [options.url='ws://localhost:8787']
     *   Provider WebSocket URL.
     * @param {boolean}  [options.debug=false]
     *   Log verbose protocol messages to stderr.
     * @param {boolean}  [options.autoReconnect=true]
     *   Automatically reconnect on unexpected disconnects.
     * @param {number}   [options.reconnectDelayMs=2000]
     *   Milliseconds to wait before a reconnect attempt.
     * @param {Function} [options.WebSocket]
     *   WebSocket constructor override.  Defaults to globalThis.WebSocket (available
     *   natively in browsers and Node.js v22+).  Pass the 'ws' package constructor
     *   for older Node.js versions.
     */
    constructor(options = {}) {
        this.url = options.url || 'ws://localhost:8787';
        this.debug = Boolean(options.debug);
        this.autoReconnect = options.autoReconnect !== false;
        this.reconnectDelayMs = Number(options.reconnectDelayMs) || 2000;

        /** @type {Function|undefined} WebSocket constructor */
        this._WebSocket = options.WebSocket || globalThis.WebSocket;

        /** @type {Map<string, Set<Function>>} */
        this._listeners = new Map();

        /** @type {WebSocket|null} */
        this._ws = null;

        /** @type {Map<string, { resolve: Function, reject: Function }>} */
        this._pendingRequests = new Map();
        this._requestCounter = 0;

        /** @type {ReturnType<typeof setTimeout>|null} */
        this._reconnectTimer = null;

        /** @type {boolean} True after disconnect() is called; suppresses auto-reconnect. */
        this._stopped = false;

        // ── Cached provider state ──────────────────────────────────────────
        // Mirrors the most-recent 'state' push message from the provider.
        // Kept in sync by _applyState() whenever a state or stateChanged message arrives.
        this._state = {
            keypadConnected: false,
            dialpadConnected: false,
            features: {
                keypad: { specialKeys: false, brightness: false, contextualDisplay: false },
                dialpad: { specialKeys: false, multiRoller: false }
            },
            brightnessInfo: null,
            contextualDisplayCaps: null,
            contextualDisplayInfo: null,
            rollerCapabilities: [],
            rollerEventCount: 0
        };

        // Cache of roleConnected events (role → device info).
        // Used to populate getAvailableDevices() with meaningful metadata.
        /** @type {Map<string, object>} */
        this._connectedDevices = new Map();

        // Local roller position tracking.
        // Kept in sync with RollerSnapshot data from rollerEvent pushes.
        this._rollerPositions = [];
        this._rollerEventCount = 0;
    }

    // ── Event emitter API ─────────────────────────────────────────────────────

    /**
     * Register a listener for a named event.
     *
     * Events that match MXCreativeConsoleClient:
     *   'status'              { message: string, isError: boolean }
     *   'stateChanged'        ConnectionState
     *   'devicesChanged'      DeviceEntry[]
     *   'roleConnected'       { role, path, productId, productName, friendlyName }
     *   'roleDisconnected'    { role, path, disconnectedByScan }
     *   'keypadKeysChanged'   { source, activeControlIds, activeLabels }
     *   'dialpadKeysChanged'  { source, activeControlIds, activeLabels }
     *   'rollerEvent'         { rollerId, delta, timestamp, eventCount, snapshot }
     *   'rollerModeChanged'   { mode, modeName, diverted }
     *   'brightnessChanged'   { raw, percent }
     *   'imageUploadComplete' { mode, keyNumber? }
     *   'rollerCleared'       { eventCount }
     *
     * Additional events added by this client (not in WebHID version):
     *   'connected'    { url }           — WebSocket connection established.
     *   'disconnected' { code, reason }  — WebSocket closed.
     *   'error'        Error             — WebSocket or protocol error.
     *
     * @param {string}   eventName
     * @param {Function} handler
     */
    on(eventName, handler) {
        if (!this._listeners.has(eventName)) {
            this._listeners.set(eventName, new Set());
        }
        this._listeners.get(eventName).add(handler);
    }

    /**
     * Remove a previously registered event listener.
     * @param {string}   eventName
     * @param {Function} handler
     */
    off(eventName, handler) {
        this._listeners.get(eventName)?.delete(handler);
    }

    /** @internal */
    _emit(eventName, payload) {
        const handlers = this._listeners.get(eventName);
        if (!handlers) return;
        for (const h of handlers) {
            try {
                h(payload);
            } catch (err) {
                console.error(`[mx-node-client][${eventName}]`, err);
            }
        }
    }

    /** @internal */
    _log(...args) {
        if (this.debug) console.log('[mx-node-client]', ...args);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Open the WebSocket connection to the provider.
     *
     * The returned Promise resolves once the first message from the provider is
     * received (the provider always sends a full 'state' snapshot immediately on
     * connect, so this effectively means "ready to use").
     *
     * If auto-reconnect is enabled (default), calling connect() after a disconnect
     * re-establishes the connection.
     *
     * @returns {Promise<void>}
     * @throws  {Error} If no WebSocket implementation is available.
     */
    connect() {
        this._stopped = false;

        return new Promise((resolve, reject) => {
            if (this._ws && this._ws.readyState <= 1 /* OPEN */) {
                resolve();
                return;
            }

            if (!this._WebSocket) {
                reject(new Error(
                    'No WebSocket implementation found. ' +
                    'Use Node.js v22+ or pass options.WebSocket = (await import(\'ws\')).WebSocket.'
                ));
                return;
            }

            let settled = false;

            const settle = (fn) => {
                if (settled) return;
                settled = true;
                fn();
            };

            let ws;
            try {
                ws = new this._WebSocket(this.url);
            } catch (err) {
                reject(err);
                return;
            }

            this._ws = ws;

            ws.addEventListener('open', () => {
                this._log('connected', this.url);
                this._emit('connected', { url: this.url });
            });

            ws.addEventListener('message', (event) => {
                this._handleMessage(event.data);
                // Resolve on the first message — the provider always sends the
                // state snapshot first, so the client is ready to use at this point.
                settle(resolve);
            });

            ws.addEventListener('error', (event) => {
                const err = event.error || new Error('WebSocket connection error');
                this._log('error', err.message || String(err));
                this._emit('error', err);
                settle(() => reject(err));
            });

            ws.addEventListener('close', (event) => {
                this._log('closed', event.code, event.reason || '');
                this._rejectAllPending(new Error('WebSocket closed'));
                this._emit('disconnected', { code: event.code, reason: event.reason });

                settle(() => reject(new Error(
                    `WebSocket closed before the initial state was received (code ${event.code})`
                )));

                if (!this._stopped && this.autoReconnect) {
                    this._scheduleReconnect();
                }
            });
        });
    }

    /**
     * Close the WebSocket connection and disable auto-reconnect.
     */
    disconnect() {
        this._stopped = true;
        if (this._reconnectTimer !== null) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
    }

    /** @internal */
    _scheduleReconnect() {
        if (this._reconnectTimer !== null) return;
        this._log(`reconnecting in ${this.reconnectDelayMs} ms…`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect().catch((err) => {
                this._log('reconnect failed:', err.message);
            });
        }, this.reconnectDelayMs);
    }

    // ── Incoming message dispatch ──────────────────────────────────────────────

    /** @internal */
    _handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
        } catch (_err) {
            this._log('unparseable message', raw);
            return;
        }

        this._log('←', msg.type, msg.event || '');

        switch (msg.type) {
            case 'response':
                this._handleResponse(msg);
                break;

            case 'state':
                // Full state snapshot — sent on connect and after each device poll.
                this._applyState(msg.state);
                this._emit('stateChanged', this.getConnectionState());
                break;

            case 'status':
                this._emit('status', { message: msg.message, isError: Boolean(msg.isError) });
                break;

            case 'event':
                this._handlePushEvent(msg.event, msg.data);
                break;

            default:
                this._log('unknown message type', msg.type);
        }
    }

    /** @internal */
    _handleResponse(msg) {
        const pending = this._pendingRequests.get(msg.requestId);
        if (!pending) return;
        this._pendingRequests.delete(msg.requestId);
        if (msg.ok) {
            pending.resolve(msg.data);
        } else {
            pending.reject(new Error(msg.error || 'Request failed'));
        }
    }

    /** @internal */
    _handlePushEvent(event, data) {
        // Keep local caches in sync before forwarding to application listeners.
        switch (event) {
            case 'stateChanged':
                this._applyState(data);
                break;
            case 'roleConnected':
                this._connectedDevices.set(data.role, data);
                break;
            case 'roleDisconnected':
                this._connectedDevices.delete(data.role);
                break;
            case 'rollerEvent':
                this._rollerEventCount = data.eventCount;
                if (Array.isArray(data.snapshot)) {
                    for (const r of data.snapshot) {
                        this._rollerPositions[r.rollerId] = r.position;
                    }
                }
                break;
            case 'brightnessChanged':
                if (this._state.brightnessInfo) {
                    this._state.brightnessInfo.currentBrightness = data.raw;
                }
                break;
        }

        this._emit(event, data);
    }

    /** @internal */
    _applyState(state) {
        if (!state) return;
        Object.assign(this._state, state);
        // Initialise roller position array to the new capability count without
        // losing any existing positions (device re-connect preserves them).
        if (state.rollerCapabilities) {
            this._rollerPositions = state.rollerCapabilities.map(
                (_r, i) => this._rollerPositions[i] ?? 0
            );
        }
        if (state.rollerEventCount != null) {
            this._rollerEventCount = state.rollerEventCount;
        }
    }

    // ── Outgoing request helpers ──────────────────────────────────────────────

    /** @internal */
    _nextRequestId() {
        this._requestCounter += 1;
        return `nc-${this._requestCounter}`;
    }

    /**
     * Send a JSON request to the provider and return a Promise that resolves with
     * the response `data` payload, or rejects with the error message string.
     *
     * Implementation note for other languages:
     *   1. Assign a unique requestId to the outgoing message.
     *   2. Store a pending entry keyed by that requestId.
     *   3. When a 'response' message arrives with the matching requestId, resolve
     *      (ok === true) or reject (ok === false) the pending entry.
     *   4. Implement a timeout to reject stale pending entries if desired.
     *
     * @param {string} action
     * @param {object} [params={}]
     * @returns {Promise<any>}
     */
    _send(action, params = {}) {
        const requestId = this._nextRequestId();

        return new Promise((resolve, reject) => {
            if (!this._ws || this._ws.readyState !== 1 /* OPEN */) {
                reject(new Error('Not connected to provider. Call connect() first.'));
                return;
            }

            this._pendingRequests.set(requestId, { resolve, reject });
            const message = JSON.stringify({ requestId, action, ...params });
            this._log('→', action, requestId);
            this._ws.send(message);
        });
    }

    /** @internal */
    _rejectAllPending(error) {
        for (const pending of this._pendingRequests.values()) {
            pending.reject(error);
        }
        this._pendingRequests.clear();
    }

    // ── Public API — shared with MXCreativeConsoleClient (WebHID) ────────────

    /**
     * Returns a snapshot of the current connection state, populated from the most
     * recent 'state' push message received from the provider.
     *
     * Shape is identical to MXCreativeConsoleClient.getConnectionState().
     *
     * @returns {object} ConnectionState
     */
    getConnectionState() {
        return {
            keypadConnected: this._state.keypadConnected,
            dialpadConnected: this._state.dialpadConnected,
            features: {
                keypad: { ...(this._state.features?.keypad ?? {}) },
                dialpad: { ...(this._state.features?.dialpad ?? {}) }
            },
            brightnessInfo: this._state.brightnessInfo ?? null,
            contextualDisplayCaps: this._state.contextualDisplayCaps ?? null,
            contextualDisplayInfo: this._state.contextualDisplayInfo ?? null,
            rollerCapabilities: [...(this._state.rollerCapabilities ?? [])],
            rollerEventCount: this._rollerEventCount
        };
    }

    /**
     * Returns a list of devices that are currently connected according to
     * cached provider state.  Shape mirrors MXCreativeConsoleClient.getAvailableDevices().
     *
     * Note: The provider manages device connections automatically, so there is no
     * user-visible device picker.  This list only contains devices that are already
     * active.
     *
     * @returns {{ index: number, role: string, friendlyName: string,
     *             productName: string, productId: number, path: string }[]}
     */
    getAvailableDevices() {
        let index = 0;
        const devices = [];
        for (const [role, info] of this._connectedDevices) {
            devices.push({
                index: index++,
                role,
                friendlyName: info.friendlyName || info.productName || role,
                productName: info.productName || role,
                productId: info.productId,
                path: info.path ?? ''
            });
        }
        return devices;
    }

    /**
     * Connects to the provider (if not already connected) and returns the
     * available-devices list.
     *
     * In the WebHID version this opens the browser HID device picker.  In this
     * client the provider handles device connections automatically, so this method
     * simply establishes the WebSocket channel.
     *
     * @returns {Promise<object[]>} Available devices (may be empty on first call
     *   before 'roleConnected' events arrive).
     */
    async requestDeviceAccessAndScan() {
        await this.connect();
        this._emit('devicesChanged', this.getAvailableDevices());
        return this.getAvailableDevices();
    }

    /**
     * Requests a fresh state snapshot from the provider and updates the local
     * cache.  Returns the same array as getAvailableDevices().
     *
     * In the WebHID version this re-enumerates all authorized HID devices.  Here
     * it issues a getState request to the provider.
     *
     * @returns {Promise<object[]>}
     */
    async scanAuthorizedDevices() {
        const state = await this._send('getState');
        if (state) this._applyState(state);
        this._emit('devicesChanged', this.getAvailableDevices());
        return this.getAvailableDevices();
    }

    /**
     * No-op in the node-client.  The provider manages device connections
     * automatically; use connect() to establish the WebSocket channel.
     *
     * Exists for API compatibility with MXCreativeConsoleClient.connectAvailableDevice().
     *
     * @param {number} _index  Ignored.
     * @returns {Promise<object>} Current connection state.
     */
    async connectAvailableDevice(_index) {
        return this.getConnectionState();
    }

    /**
     * No-op in the node-client.  Role lifecycle is managed by the provider.
     *
     * Exists for API compatibility with MXCreativeConsoleClient.disconnectRole().
     *
     * @param {string} _role  Ignored.
     */
    async disconnectRole(_role) {
        // The provider manages device connections automatically.
    }

    /**
     * Closes the WebSocket connection.
     *
     * Exists for API compatibility with MXCreativeConsoleClient.disconnectAll().
     */
    async disconnectAll() {
        this.disconnect();
    }

    /**
     * Switches the MX Dialpad roller(s) between native OS scroll mode and
     * diverted mode.  Diverted mode must be enabled to receive 'rollerEvent'
     * push messages.
     *
     * @param {boolean} enabled  true = diverted, false = native (OS scroll).
     * @returns {Promise<{ enabled: boolean }>}
     */
    async setRollerDiverted(enabled) {
        return this._send('setRollerDiverted', { enabled: Boolean(enabled) });
    }

    /**
     * Reads the current keypad display brightness from hardware.
     * Triggers a 'brightnessChanged' event in addition to the response.
     *
     * @returns {Promise<{ raw: number, percent: number } | null>}
     */
    async refreshBrightness() {
        return this._send('refreshBrightness');
    }

    /**
     * Sets the keypad display brightness.
     * Triggers a 'brightnessChanged' event in addition to the response.
     *
     * @param {number} percent  Target brightness, 0–100.
     * @returns {Promise<{ raw: number, percent: number }>}
     */
    async setBrightnessPercent(percent) {
        return this._send('setBrightness', { percent: Number(percent) });
    }

    /**
     * Uploads an image to one or more key displays on the MX Creative Keypad.
     *
     * API-compatible with MXCreativeConsoleClient.uploadContextualDisplayImage().
     * Accepts all image-source types from both environments:
     *   Browser:  File, Blob
     *   Node.js:  Buffer, Uint8Array, ArrayBuffer, or a file-path string
     *
     * Triggers an 'imageUploadComplete' event in addition to the response.
     *
     * @param {File|Blob|Buffer|Uint8Array|ArrayBuffer|string} file
     *   Image source.  Supported formats: JPEG, PNG, WebP, BMP.
     * @param {object}              [options]
     * @param {'single'|'all'|'full'} [options.mode='single']
     *   Upload target: one key, all 9 keys, or a full framebuffer.
     * @param {number}              [options.keyNumber=1]
     *   Key index 1–9.  Only used when mode is 'single'.
     * @returns {Promise<object>}
     */
    async uploadContextualDisplayImage(file, options = {}) {
        const imageBase64 = await this._fileToBase64(file);
        return this._send('setImage', {
            imageBase64,
            mode: options.mode ?? 'single',
            keyNumber: options.keyNumber != null ? Number(options.keyNumber) : 1
        });
    }

    /**
     * Resets the local roller event counter and position tracker.
     *
     * Exists for API compatibility with MXCreativeConsoleClient.clearRollerEvents().
     * Does not send a request to the provider; the counter reset is local only.
     */
    clearRollerEvents() {
        this._rollerEventCount = 0;
        this._rollerPositions = (this._state.rollerCapabilities ?? []).map(() => 0);
        this._emit('rollerCleared', { eventCount: 0 });
    }

    // ── Additional utilities (not in WebHID version) ──────────────────────────

    /**
     * Send a ping request to the provider to verify the connection is alive.
     *
     * @returns {Promise<{ pong: true }>}
     */
    async ping() {
        return this._send('ping');
    }

    // ── Internal file / encoding helpers ──────────────────────────────────────

    /**
     * Convert an image source to a base-64 data-URI string suitable for the
     * setImage provider action.
     *
     * Handles all practical input types across browser and Node.js environments:
     *
     *   Browser:  File / Blob      → ArrayBuffer → base-64
     *   Node.js:  Buffer           → .toString('base64')
     *   Node.js:  Uint8Array / ArrayBuffer → Buffer → base-64
     *   Node.js:  string (path)    → fs.readFile → Buffer → base-64
     *   Any:      string (data-URI or raw base-64) → returned as-is
     *
     * Reference implementation note:
     *   The resulting string must be a valid base-64 payload with an optional
     *   "data:<mime>;base64," prefix.  The provider strips the prefix before
     *   decoding.  Raw base-64 strings (no prefix) are also accepted.
     *
     * @param {File|Blob|Buffer|Uint8Array|ArrayBuffer|string} file
     * @returns {Promise<string>}
     * @internal
     */
    async _fileToBase64(file) {
        // Already-encoded string — pass through.
        if (typeof file === 'string') {
            if (file.startsWith('data:') || this._looksLikeBase64(file)) {
                return file;
            }
            // File path — Node.js only.
            if (typeof process !== 'undefined' && process.versions?.node) {
                const { readFile } = await import('node:fs/promises');
                const buf = await readFile(file);
                return 'data:application/octet-stream;base64,' + buf.toString('base64');
            }
            throw new Error('File path access is only supported in Node.js environments.');
        }

        // Browser: File or Blob
        if (typeof Blob !== 'undefined' && file instanceof Blob) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            return this._bytesToDataUri(bytes, file.type || 'application/octet-stream');
        }

        // Node.js: Buffer
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(file)) {
            return 'data:application/octet-stream;base64,' + file.toString('base64');
        }

        // Any: Uint8Array
        if (file instanceof Uint8Array) {
            return this._bytesToDataUri(file, 'application/octet-stream');
        }

        // Any: ArrayBuffer
        if (file instanceof ArrayBuffer) {
            return this._bytesToDataUri(new Uint8Array(file), 'application/octet-stream');
        }

        throw new Error(
            'Unsupported file argument. Pass a File, Blob, Buffer, Uint8Array, ArrayBuffer, ' +
            'or a file path string (Node.js only).'
        );
    }

    /**
     * Encode a byte array to a base-64 data-URI, using Buffer in Node.js or
     * btoa() in the browser.
     * @param {Uint8Array} bytes
     * @param {string}     mimeType
     * @returns {string}
     * @internal
     */
    _bytesToDataUri(bytes, mimeType) {
        if (typeof Buffer !== 'undefined') {
            return `data:${mimeType};base64,` + Buffer.from(bytes).toString('base64');
        }
        // Browser btoa path (handles arbitrary binary via charCode iteration)
        let binary = '';
        for (const b of bytes) binary += String.fromCharCode(b);
        return `data:${mimeType};base64,` + btoa(binary);
    }

    /**
     * Heuristic check: does this string look like a raw base-64 payload?
     * Checks only the first 64 characters to avoid scanning long strings.
     * @param {string} str
     * @returns {boolean}
     * @internal
     */
    _looksLikeBase64(str) {
        return str.length > 0 && /^[A-Za-z0-9+/]+=*$/.test(str.slice(0, 64));
    }
}
