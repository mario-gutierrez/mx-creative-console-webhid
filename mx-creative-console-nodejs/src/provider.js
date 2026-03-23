import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

import {
    LOGITECH_VENDOR_ID,
    PRODUCT_ID_KEYPAD,
    PRODUCT_ID_DIALPAD,
    RAW_VLP_REPORT_ID,
    KEYPAD_KEYS,
    DIALPAD_KEYS,
    roleFromProductId,
    brightnessToPercent,
    percentToBrightness,
    formatHex4
} from './constants.js';
import { listCreativeConsoleHidDevices, HIDNodeTransport } from './hidTransport.js';
import { HIDPP20Device } from './hidpp20.js';
import { Feature1B04SpecialKeys } from './features/feature1b04.js';
import { Feature4610MultiRoller, ReportingMode } from './features/feature4610.js';
import { Feature8040BrightnessControl } from './features/feature8040.js';
import { Feature19A1ContextualDisplay } from './features/feature19a1.js';
import { Feature0007DeviceFriendlyName } from './features/feature0007.js';
import { encodeAreaImageFromBuffer } from './imageEncoder.js';

function safeBase64ToBuffer(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('imageBase64 is required');
    }

    const commaIndex = value.indexOf(',');
    const body = commaIndex === -1 ? value : value.slice(commaIndex + 1);
    return Buffer.from(body, 'base64');
}

export class MXCreativeConsoleProvider extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.debug = Boolean(config.provider?.debug);

        this.wss = null;
        this.devicePollTimer = null;
        this.reconnectCooldownMs = Number(config.provider?.reconnectCooldownMs) || 3000;
        this.reconnectNotBeforeByPath = new Map();

        this.connectedPaths = new Set();
        this.keypadConnection = null;
        this.dialpadConnection = null;

        this.multiRollerFeature = null;
        this.keypadSpecialKeysFeature = null;
        this.dialpadSpecialKeysFeature = null;
        this.brightnessFeature = null;
        this.contextualDisplayFeature = null;
        this.contextualDisplayTransport = null;

        this.keypadSpecialKeyReportingSnapshots = [];
        this.dialpadSpecialKeyReportingSnapshots = [];

        this.keypadNormalPressedKeys = new Set();
        this.keypadDivertedPressedKeys = new Set();
        this.keypadPressedSpecialKeys = new Set();

        this.dialpadNormalPressedKeys = new Set();
        this.dialpadDivertedPressedKeys = new Set();
        this.dialpadPressedKeys = new Set();

        this.numRollers = 0;
        this.rollerCapabilities = [];
        this.rollerPositions = [];
        this.rollerEventCount = 0;

        this.brightnessInfo = null;
        this.contextualDisplayCaps = null;
        this.contextualDisplayInfo = null;

        this.features = {
            keypad: {
                specialKeys: false,
                brightness: false,
                contextualDisplay: false
            },
            dialpad: {
                specialKeys: false,
                multiRoller: false
            }
        };
    }

    log(...args) {
        if (this.debug) {
            console.log('[mx-node-provider]', ...args);
        }
    }

    status(message, isError = false) {
        const payload = { message, isError };
        this.emit('status', payload);
        this.broadcast({ type: 'status', ...payload });
        this.log(isError ? 'ERROR:' : 'INFO:', message);
    }

    getConnectionState() {
        return {
            keypadConnected: Boolean(this.keypadConnection),
            dialpadConnected: Boolean(this.dialpadConnection),
            features: {
                keypad: { ...this.features.keypad },
                dialpad: { ...this.features.dialpad }
            },
            brightnessInfo: this.brightnessInfo,
            contextualDisplayCaps: this.contextualDisplayCaps,
            contextualDisplayInfo: this.contextualDisplayInfo,
            rollerCapabilities: [...this.rollerCapabilities],
            rollerEventCount: this.rollerEventCount
        };
    }

    start() {
        const wsPort = this.config.websocket?.port || 8787;
        this.wss = new WebSocketServer({ port: wsPort });
        this.wss.on('listening', () => {
            this.status(`WebSocket API listening on ws://localhost:${wsPort}`);
        });
        this.wss.on('error', (error) => {
            this.status(`WebSocket server error: ${error.message}`, true);
            this.emit('fatalError', error);
        });
        this.wss.on('connection', (socket) => {
            socket.send(JSON.stringify({ type: 'state', state: this.getConnectionState() }));

            socket.on('message', async (raw) => {
                await this.handleClientMessage(socket, raw.toString());
            });
        });

        this.scanAndSyncDevices().catch((error) => {
            this.status(`Initial device scan failed: ${error.message}`, true);
        });

        const pollMs = Number(this.config.provider?.devicePollMs) || 1000;
        this.devicePollTimer = setInterval(() => {
            this.scanAndSyncDevices().catch((error) => {
                this.status(`Device scan failed: ${error.message}`, true);
            });
        }, pollMs);
    }

    async stop() {
        if (this.devicePollTimer) {
            clearInterval(this.devicePollTimer);
            this.devicePollTimer = null;
        }

        await this.disconnectAll();

        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
    }

    broadcast(message) {
        if (!this.wss) {
            return;
        }

        const payload = JSON.stringify(message);
        for (const client of this.wss.clients) {
            if (client.readyState === 1) {
                client.send(payload);
            }
        }
    }

    publishEvent(event, data) {
        this.emit(event, data);
        this.broadcast({ type: 'event', event, data });
    }

    async scanAndSyncDevices() {
        const devices = listCreativeConsoleHidDevices(LOGITECH_VENDOR_ID, [PRODUCT_ID_KEYPAD, PRODUCT_ID_DIALPAD]);
        const foundPaths = new Set(devices.map((device) => device.path));

        for (const connection of [this.keypadConnection, this.dialpadConnection]) {
            if (connection && !foundPaths.has(connection.path)) {
                await this.disconnectRole(connection.role, true);
            }
        }

        for (const deviceInfo of devices) {
            const role = roleFromProductId(deviceInfo.productId);
            if (!role) {
                continue;
            }

            const path = deviceInfo.path;
            if (path && Date.now() < (this.reconnectNotBeforeByPath.get(path) || 0)) {
                continue;
            }

            const alreadyConnected = role === 'keypad' ? this.keypadConnection : this.dialpadConnection;
            if (alreadyConnected) {
                continue;
            }

            await this.connectDevice(deviceInfo, role);
        }

        this.broadcast({ type: 'state', state: this.getConnectionState() });
    }

    async connectDevice(deviceInfo, role) {
        const path = deviceInfo.path;
        if (!path || this.connectedPaths.has(path)) {
            return;
        }

        this.status(`Connecting ${role} (${formatHex4(deviceInfo.productId)})...`);

        const transport = new HIDNodeTransport(deviceInfo);
        const hidppDevice = new HIDPP20Device(transport);

        try {
            hidppDevice.open();

            const rawInputHandler = (event) => this.handleRawVlpInputReport(role, event);
            transport.on('inputreport', rawInputHandler);
            transport.on('transportError', async (error) => {
                this.status(`${role} transport error: ${error.message}`, true);
                if (path) {
                    this.reconnectNotBeforeByPath.set(path, Date.now() + this.reconnectCooldownMs);
                }
                await this.disconnectRole(role, true);
            });

            const connection = {
                role,
                path,
                transport,
                hidppDevice,
                rawInputHandler,
                specialKeyHandler: (controlIds) => this.handleSpecialKeyChange(role, controlIds),
                productName: deviceInfo.product || deviceInfo.productName || 'Unknown',
                usagePage: deviceInfo.usagePage,
                usage: deviceInfo.usage
            };

            if (role === 'dialpad') {
                this.dialpadConnection = connection;
                await this.initializeRollers(hidppDevice);
                await this.initializeSpecialKeys('dialpad', hidppDevice, connection.specialKeyHandler);

                if (!this.features.dialpad.multiRoller && !this.features.dialpad.specialKeys) {
                    throw new Error(
                        `Dialpad interface path is not HID++ compatible (usagePage=${connection.usagePage}, usage=${connection.usage}).`
                    );
                }
            } else {
                this.keypadConnection = connection;
                await this.initializeSpecialKeys('keypad', hidppDevice, connection.specialKeyHandler);
                await this.initializeContextualDisplay(hidppDevice);
                await this.initializeBrightness(hidppDevice);

                if (!this.features.keypad.contextualDisplay && !this.features.keypad.brightness && !this.features.keypad.specialKeys) {
                    throw new Error(
                        `Keypad interface path is not HID++ compatible (usagePage=${connection.usagePage}, usage=${connection.usage}).`
                    );
                }
            }

            this.connectedPaths.add(path);

            // Keypad distributes HID++ events and raw VLP key events across separate HID
            // collections. Open all additional same-device paths as secondary listeners
            // so that keys 1-9 (report 0x13 on a different collection) are received.
            if (role === 'keypad') {
                this.openSecondaryVlpListeners(connection);
            }

            try {
                const friendlyNameFeature = new Feature0007DeviceFriendlyName(hidppDevice);
                await friendlyNameFeature.initialize();
                connection.friendlyName = await friendlyNameFeature.getFriendlyName();
            } catch (_error) {
                connection.friendlyName = connection.productName;
            }

            this.publishEvent('roleConnected', {
                role,
                path,
                productId: deviceInfo.productId,
                productName: connection.productName,
                friendlyName: connection.friendlyName
            });
            this.publishEvent('stateChanged', this.getConnectionState());
            this.status(`${role} connected.`);
        } catch (error) {
            this.status(`Failed connecting ${role}: ${error.message}`, true);
            if (path) {
                this.reconnectNotBeforeByPath.set(path, Date.now() + this.reconnectCooldownMs);
            }
            try {
                hidppDevice.close();
            } catch (_closeError) {
                // Ignore close errors after failed init.
            }

            if (role === 'keypad') {
                this.keypadConnection = null;
            } else {
                this.dialpadConnection = null;
            }
        }
    }

    async disconnectRole(role, disconnectedByScan = false) {
        const connection = role === 'keypad' ? this.keypadConnection : this.dialpadConnection;
        if (!connection) {
            return;
        }

        try {
            connection.transport.off('inputreport', connection.rawInputHandler);
        } catch (_error) {
            // Ignore cleanup failures.
        }

        if (role === 'keypad') {
            if (this.keypadSpecialKeysFeature) {
                try {
                    await this.keypadSpecialKeysFeature.restoreReporting(this.keypadSpecialKeyReportingSnapshots);
                } catch (_error) {
                    // Keep disconnect resilient.
                }
                this.keypadSpecialKeysFeature.offKeyChange(connection.specialKeyHandler);
            }

            if (this.contextualDisplayFeature) {
                this.contextualDisplayFeature.close();
            }

            if (this.contextualDisplayTransport) {
                try {
                    this.contextualDisplayTransport.close();
                } catch (_error) {
                    // Ignore cleanup failures.
                }

                this.contextualDisplayTransport = null;
            }

            if (connection.secondaryTransports) {
                for (const secondary of connection.secondaryTransports) {
                    try {
                        secondary.transport.off('inputreport', secondary.rawHandler);
                        secondary.transport.close();
                    } catch (_error) {
                        // Ignore cleanup failures on secondary paths.
                    }

                    this.connectedPaths.delete(secondary.path);
                }
            }

            this.keypadConnection = null;
            this.keypadSpecialKeysFeature = null;
            this.keypadSpecialKeyReportingSnapshots = [];
            this.keypadNormalPressedKeys.clear();
            this.keypadDivertedPressedKeys.clear();
            this.keypadPressedSpecialKeys.clear();

            this.features.keypad.specialKeys = false;
            this.features.keypad.brightness = false;
            this.features.keypad.contextualDisplay = false;

            this.brightnessFeature = null;
            this.brightnessInfo = null;
            this.contextualDisplayFeature = null;
            this.contextualDisplayCaps = null;
            this.contextualDisplayInfo = null;
        } else {
            if (this.dialpadSpecialKeysFeature) {
                try {
                    await this.dialpadSpecialKeysFeature.restoreReporting(this.dialpadSpecialKeyReportingSnapshots);
                } catch (_error) {
                    // Keep disconnect resilient.
                }
                this.dialpadSpecialKeysFeature.offKeyChange(connection.specialKeyHandler);
            }

            if (this.multiRollerFeature) {
                for (let i = 0; i < this.numRollers; i += 1) {
                    try {
                        await this.multiRollerFeature.setMode(i, ReportingMode.Native);
                    } catch (_error) {
                        // Keep disconnect resilient.
                    }
                }
            }

            this.dialpadConnection = null;
            this.dialpadSpecialKeysFeature = null;
            this.dialpadSpecialKeyReportingSnapshots = [];
            this.dialpadNormalPressedKeys.clear();
            this.dialpadDivertedPressedKeys.clear();
            this.dialpadPressedKeys.clear();

            this.multiRollerFeature = null;
            this.numRollers = 0;
            this.rollerCapabilities = [];
            this.rollerPositions = [];
            this.rollerEventCount = 0;

            this.features.dialpad.specialKeys = false;
            this.features.dialpad.multiRoller = false;
        }

        try {
            connection.hidppDevice.close();
        } catch (_error) {
            // Ignore transport close failures.
        }

        this.connectedPaths.delete(connection.path);
        if (disconnectedByScan && connection.path) {
            this.reconnectNotBeforeByPath.set(connection.path, Date.now() + this.reconnectCooldownMs);
        }

        this.publishEvent('roleDisconnected', { role, path: connection.path, disconnectedByScan });
        this.publishEvent('stateChanged', this.getConnectionState());
    }

    async disconnectAll() {
        await this.disconnectRole('keypad');
        await this.disconnectRole('dialpad');
    }

    openSecondaryVlpListeners(connection) {
        const allDevices = listCreativeConsoleHidDevices(LOGITECH_VENDOR_ID, [PRODUCT_ID_KEYPAD]);
        const secondaries = [];

        for (const deviceInfo of allDevices) {
            if (!deviceInfo.path || deviceInfo.path === connection.path) {
                continue;
            }

            // Only attach the raw keypad VLP collection (keys 1-9).
            // Opening unrelated collections can interfere with other HID roles.
            if (deviceInfo.usagePage !== 0xff43 || deviceInfo.usage !== 0x1a08) {
                continue;
            }

            if (this.connectedPaths.has(deviceInfo.path)) {
                continue;
            }

            try {
                const transport = new HIDNodeTransport(deviceInfo);
                transport.open();

                const rawHandler = (event) => this.handleRawVlpInputReport('keypad', event);
                transport.on('inputreport', rawHandler);

                // Silently drop errors on secondary paths — they do not control role lifecycle.
                transport.on('transportError', () => {
                    try {
                        transport.close();
                    } catch (_error) {
                        // Ignore.
                    }

                    this.connectedPaths.delete(deviceInfo.path);
                });

                this.connectedPaths.add(deviceInfo.path);
                secondaries.push({ transport, rawHandler, path: deviceInfo.path });
                this.log(`Secondary VLP listener: usagePage=${deviceInfo.usagePage} usage=${deviceInfo.usage}`);
            } catch (_error) {
                // Some collections may refuse to open (e.g. exclusive system drivers).
                this.log(`Could not open secondary listener for ${deviceInfo.path}: ${_error.message}`);
            }
        }

        connection.secondaryTransports = secondaries;
    }

    openKeypadDisplayTransport(primaryConnection) {
        const allDevices = listCreativeConsoleHidDevices(LOGITECH_VENDOR_ID, [PRODUCT_ID_KEYPAD]);

        for (const deviceInfo of allDevices) {
            if (!deviceInfo.path || deviceInfo.path === primaryConnection.path) {
                continue;
            }

            // Dedicated contextual-display report output collection.
            if (deviceInfo.usagePage !== 0xff43 || deviceInfo.usage !== 0x1a10) {
                continue;
            }

            try {
                const transport = new HIDNodeTransport(deviceInfo);
                transport.open();
                this.log(`Contextual display transport: usagePage=${deviceInfo.usagePage} usage=${deviceInfo.usage}`);
                return transport;
            } catch (_error) {
                this.log(`Could not open contextual display transport for ${deviceInfo.path}: ${_error.message}`);
            }
        }

        return null;
    }

    async initializeRollers(hidppDevice) {
        this.multiRollerFeature = null;
        this.features.dialpad.multiRoller = false;
        this.numRollers = 0;
        this.rollerCapabilities = [];
        this.rollerPositions = [];
        this.rollerEventCount = 0;

        try {
            this.multiRollerFeature = new Feature4610MultiRoller(hidppDevice);
            await this.multiRollerFeature.initialize();

            this.numRollers = await this.multiRollerFeature.getCapabilities();
            for (let i = 0; i < this.numRollers; i += 1) {
                const caps = await this.multiRollerFeature.getRollerCapabilities(i);
                this.rollerCapabilities.push(caps);
            }

            this.features.dialpad.multiRoller = this.numRollers > 0;
            this.resetRollerPositions();

            this.multiRollerFeature.onRotationEvent((rollerId, delta, timestamp) => {
                this.handleRotationEvent(rollerId, delta, timestamp);
            });
        } catch (_error) {
            this.multiRollerFeature = null;
            this.features.dialpad.multiRoller = false;
        }
    }

    async initializeSpecialKeys(role, hidppDevice, keyHandler) {
        if (role === 'keypad') {
            this.keypadSpecialKeysFeature = null;
            this.keypadSpecialKeyReportingSnapshots = [];
            this.features.keypad.specialKeys = false;
        } else {
            this.dialpadSpecialKeysFeature = null;
            this.dialpadSpecialKeyReportingSnapshots = [];
            this.features.dialpad.specialKeys = false;
        }

        try {
            const feature = new Feature1B04SpecialKeys(hidppDevice);
            await feature.initialize();
            feature.onKeyChange(keyHandler);
            const snapshots = await feature.configureDiversionReporting();

            if (role === 'keypad') {
                this.keypadSpecialKeysFeature = feature;
                this.keypadSpecialKeyReportingSnapshots = snapshots;
                this.features.keypad.specialKeys = true;
            } else {
                this.dialpadSpecialKeysFeature = feature;
                this.dialpadSpecialKeyReportingSnapshots = snapshots;
                this.features.dialpad.specialKeys = true;
            }
        } catch (_error) {
            // Some firmware revisions may not expose this feature; continue without it.
        }
    }

    async initializeBrightness(hidppDevice) {
        this.brightnessFeature = null;
        this.brightnessInfo = null;
        this.features.keypad.brightness = false;

        try {
            this.brightnessFeature = new Feature8040BrightnessControl(hidppDevice);
            await this.brightnessFeature.initialize();
            this.brightnessInfo = await this.brightnessFeature.getInfo();
            this.features.keypad.brightness = true;
            await this.refreshBrightness();
        } catch (_error) {
            this.brightnessFeature = null;
            this.brightnessInfo = null;
            this.features.keypad.brightness = false;
        }
    }

    async initializeContextualDisplay(hidppDevice) {
        this.contextualDisplayFeature = null;
        this.contextualDisplayTransport = null;
        this.contextualDisplayCaps = null;
        this.contextualDisplayInfo = null;
        this.features.keypad.contextualDisplay = false;

        try {
            this.contextualDisplayTransport = this.openKeypadDisplayTransport(this.keypadConnection);
            this.contextualDisplayFeature = new Feature19A1ContextualDisplay(hidppDevice, this.contextualDisplayTransport);
            await this.contextualDisplayFeature.initialize();

            const caps = await this.contextualDisplayFeature.getCapabilities();
            if (!caps || !caps.deviceScreenCount) {
                throw new Error('No contextual displays reported by feature 19A1.');
            }

            const displayInfo = await this.contextualDisplayFeature.getDisplayInfo(1);
            this.contextualDisplayCaps = caps;
            this.contextualDisplayInfo = displayInfo;
            this.features.keypad.contextualDisplay = true;
        } catch (_error) {
            if (this.contextualDisplayFeature) {
                this.contextualDisplayFeature.close();
            }
            if (this.contextualDisplayTransport) {
                try {
                    this.contextualDisplayTransport.close();
                } catch (_closeError) {
                    // Ignore cleanup failures.
                }
            }
            this.contextualDisplayTransport = null;
            this.contextualDisplayFeature = null;
            this.contextualDisplayCaps = null;
            this.contextualDisplayInfo = null;
            this.features.keypad.contextualDisplay = false;
        }
    }

    async setRollerDiverted(enabled) {
        if (!this.multiRollerFeature || this.rollerCapabilities.length === 0) {
            throw new Error('Multi-roller feature is unavailable.');
        }

        const mode = enabled ? ReportingMode.Diverted : ReportingMode.Native;
        for (const roller of this.rollerCapabilities) {
            await this.multiRollerFeature.setMode(roller.rollerId, mode);
        }

        this.publishEvent('rollerModeChanged', {
            mode,
            modeName: Feature4610MultiRoller.getModeString(mode),
            diverted: mode === ReportingMode.Diverted
        });
    }

    async refreshBrightness() {
        if (!this.brightnessFeature || !this.brightnessInfo) {
            return null;
        }

        const raw = await this.brightnessFeature.getBrightness();
        const percent = brightnessToPercent(raw, this.brightnessInfo.minBrightness, this.brightnessInfo.maxBrightness);

        const payload = { raw, percent };
        this.publishEvent('brightnessChanged', payload);
        return payload;
    }

    async setBrightnessPercent(percent) {
        if (!this.brightnessFeature || !this.brightnessInfo) {
            throw new Error('Brightness feature is unavailable.');
        }

        const raw = percentToBrightness(percent, this.brightnessInfo.minBrightness, this.brightnessInfo.maxBrightness);
        await this.brightnessFeature.setBrightness(raw);
        return this.refreshBrightness();
    }

    async uploadContextualDisplayImageFromBase64({ imageBase64, mode = 'single', keyNumber = 1 }) {
        if (!this.contextualDisplayFeature || !this.contextualDisplayInfo || !this.contextualDisplayCaps) {
            throw new Error('Feature 0x19A1 is not available on this device.');
        }

        const imageBuffer = safeBase64ToBuffer(imageBase64);

        if (mode === 'single') {
            const numericKey = Number(keyNumber);
            if (!Number.isFinite(numericKey) || numericKey < 1 || numericKey > 9) {
                throw new Error('keyNumber must be between 1 and 9 for single mode.');
            }

            const button = this.contextualDisplayInfo.buttons[numericKey - 1];
            const encoded = await encodeAreaImageFromBuffer(imageBuffer, button.location.w, button.location.h, this.contextualDisplayCaps);

            await this.contextualDisplayFeature.setImage(1, false, [{
                imageFormat: encoded.imageFormat,
                location: button.location,
                imageData: encoded.imageData
            }]);

            const payload = { mode, keyNumber: numericKey };
            this.publishEvent('imageUploadComplete', payload);
            return payload;
        }

        if (mode === 'all') {
            if (this.contextualDisplayInfo.buttons.length < 9) {
                throw new Error(`Expected at least 9 buttons, got ${this.contextualDisplayInfo.buttons.length}.`);
            }

            const firstButton = this.contextualDisplayInfo.buttons[0];
            const sharedEncoded = await encodeAreaImageFromBuffer(
                imageBuffer,
                firstButton.location.w,
                firstButton.location.h,
                this.contextualDisplayCaps
            );

            for (let index = 0; index < 9; index += 1) {
                const button = this.contextualDisplayInfo.buttons[index];
                const defer = index < 8;

                await this.contextualDisplayFeature.setImage(1, defer, [{
                    imageFormat: sharedEncoded.imageFormat,
                    location: button.location,
                    imageData: sharedEncoded.imageData
                }]);
            }

            const payload = { mode };
            this.publishEvent('imageUploadComplete', payload);
            return payload;
        }

        const fullWidth = this.contextualDisplayInfo.resHorizontal;
        const fullHeight = this.contextualDisplayInfo.resVertical;
        const encoded = await encodeAreaImageFromBuffer(imageBuffer, fullWidth, fullHeight, this.contextualDisplayCaps);

        await this.contextualDisplayFeature.setImage(1, false, [{
            imageFormat: encoded.imageFormat,
            location: { x: 0, y: 0, w: fullWidth, h: fullHeight },
            imageData: encoded.imageData
        }]);

        const payload = { mode: 'full' };
        this.publishEvent('imageUploadComplete', payload);
        return payload;
    }

    handleRawVlpInputReport(role, event) {
        if (event.reportId !== RAW_VLP_REPORT_ID) {
            return;
        }

        const data = Uint8Array.from(event.data);
        if (data.length < 6) {
            return;
        }

        if (!(data[0] === 0xff && data[1] === 0x02 && data[2] === 0x00)) {
            return;
        }

        const keys = new Set();
        for (let i = 5; i < data.length; i += 1) {
            const keyId = data[i];
            if (keyId === 0) {
                break;
            }
            keys.add(keyId);
        }

        if (role === 'keypad') {
            this.keypadNormalPressedKeys = keys;
        } else {
            this.dialpadNormalPressedKeys = keys;
        }

        this.syncUnifiedPressedKeys(role, 'raw');
    }

    handleSpecialKeyChange(role, controlIds) {
        if (role === 'keypad') {
            this.keypadDivertedPressedKeys.clear();
        } else {
            this.dialpadDivertedPressedKeys.clear();
        }

        for (const controlId of controlIds) {
            if (controlId !== 0) {
                if (role === 'keypad') {
                    this.keypadDivertedPressedKeys.add(controlId);
                } else {
                    this.dialpadDivertedPressedKeys.add(controlId);
                }
            }
        }

        this.syncUnifiedPressedKeys(role, 'diverted');
    }

    syncUnifiedPressedKeys(role, source) {
        if (role === 'keypad') {
            this.keypadPressedSpecialKeys.clear();

            for (const keyId of this.keypadNormalPressedKeys) {
                if (!DIALPAD_KEYS.some((key) => (key.controlId & 0xff) === keyId)) {
                    this.keypadPressedSpecialKeys.add(keyId);
                }
            }

            for (const keyId of this.keypadDivertedPressedKeys) {
                if (!DIALPAD_KEYS.some((key) => key.controlId === keyId)) {
                    this.keypadPressedSpecialKeys.add(keyId);
                }
            }

            const activeControlIds = Array.from(this.keypadPressedSpecialKeys);
            const activeLabels = KEYPAD_KEYS
                .filter((key) => this.keypadPressedSpecialKeys.has(key.controlId))
                .map((key) => key.label);

            this.publishEvent('keypadKeysChanged', { source, activeControlIds, activeLabels });
            return;
        }

        this.dialpadPressedKeys.clear();

        const dialControlIds = new Set(DIALPAD_KEYS.map((key) => key.controlId));
        const dialLowByteIds = new Set(DIALPAD_KEYS.map((key) => key.controlId & 0xff));

        for (const keyId of this.dialpadNormalPressedKeys) {
            if (dialControlIds.has(keyId) || dialLowByteIds.has(keyId)) {
                this.dialpadPressedKeys.add(keyId);
            }
        }

        for (const keyId of this.dialpadDivertedPressedKeys) {
            if (DIALPAD_KEYS.some((key) => key.controlId === keyId)) {
                this.dialpadPressedKeys.add(keyId);
            }
        }

        const activeControlIds = Array.from(this.dialpadPressedKeys);
        const activeLabels = DIALPAD_KEYS
            .filter((key) => this.dialpadPressedKeys.has(key.controlId) || this.dialpadPressedKeys.has(key.controlId & 0xff))
            .map((key) => key.label);

        this.publishEvent('dialpadKeysChanged', { source, activeControlIds, activeLabels });
    }

    resetRollerPositions() {
        this.rollerPositions = this.rollerCapabilities.map(() => 0);
    }

    getRollerCapability(rollerId) {
        return this.rollerCapabilities.find((roller) => roller.rollerId === rollerId) || null;
    }

    getRollerSnapshot(changedRollerId, delta) {
        const capability = this.getRollerCapability(changedRollerId);
        const incrementsPerRotation = capability?.incrementsPerRotation || 1;
        const currentPosition = this.rollerPositions[changedRollerId] || 0;
        const updatedPosition = ((currentPosition + delta) % incrementsPerRotation + incrementsPerRotation) % incrementsPerRotation;
        this.rollerPositions[changedRollerId] = updatedPosition;

        return [0, 1].map((rollerId) => {
            const rollerCapability = this.getRollerCapability(rollerId);
            const rollerIncrements = rollerCapability?.incrementsPerRotation || 1;
            const position = ((this.rollerPositions[rollerId] || 0) % rollerIncrements + rollerIncrements) % rollerIncrements;

            return {
                rollerId,
                available: Boolean(rollerCapability),
                isChanged: rollerId === changedRollerId,
                directionClass: rollerId === changedRollerId ? (delta >= 0 ? 'up' : 'down') : 'idle',
                progress: Math.max(0, Math.min(1, position / rollerIncrements)),
                position,
                incrementsPerRotation: rollerIncrements
            };
        });
    }

    handleRotationEvent(rollerId, delta, timestamp) {
        this.rollerEventCount += 1;
        const snapshot = this.getRollerSnapshot(rollerId, delta);

        this.publishEvent('rollerEvent', {
            rollerId,
            delta,
            timestamp,
            eventCount: this.rollerEventCount,
            snapshot
        });
    }

    async handleClientMessage(socket, message) {
        let request;
        try {
            request = JSON.parse(message);
        } catch (_error) {
            socket.send(JSON.stringify({ type: 'error', error: 'Invalid JSON payload' }));
            return;
        }

        const requestId = request.requestId || null;

        const respond = (payload) => {
            socket.send(JSON.stringify({
                type: 'response',
                requestId,
                ...payload
            }));
        };

        try {
            switch (request.action) {
                case 'ping':
                    respond({ ok: true, data: { pong: true } });
                    return;
                case 'getState':
                    respond({ ok: true, data: this.getConnectionState() });
                    return;
                case 'refreshBrightness': {
                    const data = await this.refreshBrightness();
                    respond({ ok: true, data });
                    return;
                }
                case 'setBrightness': {
                    const data = await this.setBrightnessPercent(request.percent);
                    respond({ ok: true, data });
                    return;
                }
                case 'setRollerDiverted': {
                    await this.setRollerDiverted(Boolean(request.enabled));
                    respond({ ok: true, data: { enabled: Boolean(request.enabled) } });
                    return;
                }
                case 'setImage': {
                    const data = await this.uploadContextualDisplayImageFromBase64({
                        imageBase64: request.imageBase64,
                        mode: request.mode,
                        keyNumber: request.keyNumber
                    });
                    respond({ ok: true, data });
                    return;
                }
                default:
                    respond({ ok: false, error: `Unknown action: ${request.action}` });
            }
        } catch (error) {
            respond({ ok: false, error: error.message });
        }
    }
}
