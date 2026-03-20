/**
 * Reusable WebHID client for Logitech MX Creative Console devices.
 */

import { HIDPP20Device, getAuthorizedDevices, requestLogitechDevices } from './hidpp20.js';
import { Feature4610MultiRoller, ReportingMode } from './feature4610.js';
import { Feature1B04SpecialKeys } from './feature1b04.js';
import { Feature0007DeviceFriendlyName } from './feature0007.js';
import { Feature8040BrightnessControl } from './feature8040.js';
import { Feature19A1ContextualDisplay } from './feature19a1.js';

const FEATURE_ID_MULTIROLLER = 0x4610;
const FEATURE_ID_SPECIAL_KEYS = 0x1b04;
const FEATURE_ID_BRIGHTNESS = 0x8040;
const FEATURE_ID_CONTEXTUAL_DISPLAY = 0x19a1;
const RAW_VLP_REPORT_ID = 0x13;

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

function formatHex4(value) {
    return `0x${value.toString(16).padStart(4, '0').toUpperCase()}`;
}

function clampProgress(progress) {
    if (!Number.isFinite(progress)) {
        return 0;
    }
    return Math.max(0, Math.min(1, progress));
}

function brightnessToPercent(rawBrightness, minBrightness, maxBrightness) {
    if (maxBrightness <= minBrightness) {
        return Math.min(100, Math.max(0, rawBrightness));
    }

    const range = maxBrightness - minBrightness;
    const normalized = rawBrightness > minBrightness ? rawBrightness - minBrightness : 0;
    const percent = Math.round((normalized * 100) / range);
    return Math.min(100, Math.max(0, percent));
}

function percentToBrightness(percent, minBrightness, maxBrightness) {
    let safePercent = Number(percent);
    if (!Number.isFinite(safePercent)) {
        safePercent = 0;
    }

    safePercent = Math.round(Math.max(0, Math.min(100, safePercent)));

    if (maxBrightness <= minBrightness) {
        return safePercent;
    }

    const range = maxBrightness - minBrightness;
    return minBrightness + Math.round((safePercent * range) / 100);
}

function blobToUint8Array(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.onerror = () => reject(new Error('Failed to read image blob.'));
        reader.readAsArrayBuffer(blob);
    });
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Failed to encode canvas image.'));
                return;
            }
            resolve(blob);
        }, type, quality);
    });
}

export class MXCreativeConsoleClient {
    constructor(options = {}) {
        this.debug = Boolean(options.debug);
        this.listeners = new Map();

        this.availableDevices = [];
        this.keypadConnection = null;
        this.dialpadConnection = null;

        this.multiRollerFeature = null;
        this.keypadSpecialKeysFeature = null;
        this.dialpadSpecialKeysFeature = null;
        this.brightnessFeature = null;
        this.contextualDisplayFeature = null;

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

    on(eventName, handler) {
        if (!this.listeners.has(eventName)) {
            this.listeners.set(eventName, new Set());
        }
        this.listeners.get(eventName).add(handler);
    }

    off(eventName, handler) {
        const handlers = this.listeners.get(eventName);
        if (!handlers) {
            return;
        }
        handlers.delete(handler);
    }

    emit(eventName, payload) {
        const handlers = this.listeners.get(eventName);
        if (!handlers) {
            return;
        }

        for (const handler of handlers) {
            try {
                handler(payload);
            } catch (error) {
                console.error(`[mx-webhid][listener:${eventName}]`, error);
            }
        }
    }

    log(...args) {
        if (this.debug) {
            console.log('[mx-webhid]', ...args);
        }
    }

    status(message, isError = false) {
        this.emit('status', { message, isError });
    }

    classifyDeviceRole(deviceEntry) {
        if (deviceEntry.supportsContextualDisplay) {
            return 'keypad';
        }

        if (deviceEntry.supportsMultiRoller) {
            return 'dialpad';
        }

        return 'keypad';
    }

    getAvailableDevices() {
        return this.availableDevices.map((entry, index) => ({
            ...entry,
            index,
            role: this.classifyDeviceRole(entry)
        }));
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

    async requestDeviceAccessAndScan() {
        this.status('Requesting Logitech device permission...');

        if (!navigator.hid) {
            throw new Error('WebHID is not supported in this browser. Please use Chrome, Edge, or Opera.');
        }

        await requestLogitechDevices();
        await this.scanAuthorizedDevices();

        if (this.availableDevices.length === 0) {
            this.status('No authorized MX Creative-compatible devices were found.', true);
        } else {
            this.status('Select a device from the list to connect.');
        }

        return this.getAvailableDevices();
    }

    async scanAuthorizedDevices() {
        const devices = await getAuthorizedDevices();
        const metadata = [];

        for (const device of devices) {
            metadata.push(await this.buildDeviceMetadata(device));
        }

        this.availableDevices = metadata.filter((entry) => entry.supportsAnyFeature);
        this.emit('devicesChanged', this.getAvailableDevices());
        return this.getAvailableDevices();
    }

    async probeFeatureSupport(hidppDevice, featureId) {
        try {
            if (featureId === FEATURE_ID_CONTEXTUAL_DISPLAY) {
                const probe = new Feature19A1ContextualDisplay(hidppDevice);
                try {
                    await probe.initialize();
                    return true;
                } finally {
                    probe.close();
                }
            }

            await hidppDevice.getFeatureIndex(featureId);
            return true;
        } catch (_error) {
            return false;
        }
    }

    async buildDeviceMetadata(device) {
        let openedByUs = false;
        let localInputReportHandler = null;

        let supportsMultiRoller = false;
        let supportsSpecialKeys = false;
        let supportsBrightness = false;
        let supportsContextualDisplay = false;

        let friendlyName = '';
        let nameSource = 'productName';

        try {
            if (!device.opened) {
                await device.open();
                openedByUs = true;
            }

            const hidppDevice = new HIDPP20Device(device);
            localInputReportHandler = hidppDevice.handleInputReport.bind(hidppDevice);
            device.addEventListener('inputreport', localInputReportHandler);

            supportsMultiRoller = await this.probeFeatureSupport(hidppDevice, FEATURE_ID_MULTIROLLER);
            supportsSpecialKeys = await this.probeFeatureSupport(hidppDevice, FEATURE_ID_SPECIAL_KEYS);
            supportsBrightness = await this.probeFeatureSupport(hidppDevice, FEATURE_ID_BRIGHTNESS);
            supportsContextualDisplay = await this.probeFeatureSupport(hidppDevice, FEATURE_ID_CONTEXTUAL_DISPLAY);

            try {
                const feature0007 = new Feature0007DeviceFriendlyName(hidppDevice);
                await feature0007.initialize();
                const name = await feature0007.getFriendlyName();
                if (name) {
                    friendlyName = name;
                    nameSource = '0x0007';
                }
            } catch (_error) {
                friendlyName = '';
            }
        } catch (error) {
            console.warn(`Failed probing device ${formatHex4(device.productId)}:`, error);
        } finally {
            if (localInputReportHandler) {
                try {
                    device.removeEventListener('inputreport', localInputReportHandler);
                } catch (_removeError) {
                    // Ignore listener cleanup failures.
                }
            }

            if (openedByUs) {
                try {
                    await device.close();
                } catch (closeError) {
                    console.warn('Failed to close probed device:', closeError);
                }
            }
        }

        if (!friendlyName) {
            friendlyName = device.productName || 'Unknown';
        }

        return {
            device,
            supportsMultiRoller,
            supportsSpecialKeys,
            supportsBrightness,
            supportsContextualDisplay,
            supportsAnyFeature: supportsMultiRoller || supportsSpecialKeys || supportsBrightness || supportsContextualDisplay,
            friendlyName,
            nameSource,
            productName: device.productName || 'Unknown',
            productId: device.productId,
            vendorId: device.vendorId
        };
    }

    async connectAvailableDevice(index) {
        if (index < 0 || index >= this.availableDevices.length) {
            throw new Error('Invalid device selection.');
        }

        const deviceEntry = this.availableDevices[index];
        const role = this.classifyDeviceRole(deviceEntry);
        await this.connectDevice(role, deviceEntry);
        return this.getConnectionState();
    }

    createRawInputReportHandler(role) {
        return (event) => this.handleRawVlpInputReport(role, event);
    }

    createSpecialKeyHandler(role) {
        return (controlIds) => this.handleSpecialKeyChange(role, controlIds);
    }

    async connectDevice(role, deviceEntry) {
        await this.disconnectRole(role);
        this.status(`Opening selected ${role} device...`);

        try {
            const device = deviceEntry.device;
            const hidppDevice = new HIDPP20Device(device);
            await hidppDevice.open();

            const rawInputHandler = this.createRawInputReportHandler(role);
            device.addEventListener('inputreport', rawInputHandler);

            const connection = {
                role,
                device,
                hidppDevice,
                rawInputHandler,
                specialKeyHandler: this.createSpecialKeyHandler(role)
            };

            this.status(`Initializing ${role} monitor features...`);

            if (role === 'dialpad') {
                this.dialpadConnection = connection;
                await this.initializeRollers(hidppDevice);
                await this.initializeSpecialKeys('dialpad', hidppDevice, connection.specialKeyHandler);
            } else {
                this.keypadConnection = connection;
                await this.initializeSpecialKeys('keypad', hidppDevice, connection.specialKeyHandler);
                await this.initializeContextualDisplay(hidppDevice);
                await this.initializeBrightness(hidppDevice);
            }

            this.emit('roleConnected', { role, deviceEntry });
            this.emit('stateChanged', this.getConnectionState());
            this.status(`${role} connected successfully.`);
        } catch (error) {
            await this.disconnectRole(role);
            this.status(`Error: ${error.message}`, true);
            throw error;
        }
    }

    async disconnectRole(role) {
        const connection = role === 'keypad' ? this.keypadConnection : this.dialpadConnection;
        if (!connection) {
            return;
        }

        try {
            connection.device.removeEventListener('inputreport', connection.rawInputHandler);
        } catch (_error) {
            // Ignore listener cleanup failures.
        }

        if (role === 'keypad') {
            if (this.keypadSpecialKeysFeature) {
                try {
                    await this.keypadSpecialKeysFeature.restoreReporting(this.keypadSpecialKeyReportingSnapshots);
                } catch (error) {
                    console.error('Error restoring keypad special key reporting:', error);
                }
                this.keypadSpecialKeysFeature.offKeyChange(connection.specialKeyHandler);
            }

            if (this.contextualDisplayFeature) {
                this.contextualDisplayFeature.close();
            }

            await connection.hidppDevice.close();

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
                } catch (error) {
                    console.error('Error restoring dialpad special key reporting:', error);
                }
                this.dialpadSpecialKeysFeature.offKeyChange(connection.specialKeyHandler);
            }

            if (this.multiRollerFeature) {
                for (let i = 0; i < this.numRollers; i++) {
                    try {
                        await this.multiRollerFeature.setMode(i, ReportingMode.Native);
                    } catch (_error) {
                        // Keep disconnect resilient.
                    }
                }
            }

            await connection.hidppDevice.close();

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

        this.emit('roleDisconnected', { role });
        this.emit('stateChanged', this.getConnectionState());
    }

    async disconnectAll() {
        await this.disconnectRole('keypad');
        await this.disconnectRole('dialpad');
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
            for (let i = 0; i < this.numRollers; i++) {
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
            this.numRollers = 0;
            this.rollerCapabilities = [];
            this.rollerPositions = [];
        }
    }

    async initializeSpecialKeys(role, hidppDevice, keyHandler) {
        if (role === 'keypad') {
            this.keypadSpecialKeysFeature = null;
            this.keypadSpecialKeyReportingSnapshots = [];
        } else {
            this.dialpadSpecialKeysFeature = null;
            this.dialpadSpecialKeyReportingSnapshots = [];
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
            if (role === 'keypad') {
                this.keypadSpecialKeysFeature = null;
                this.keypadSpecialKeyReportingSnapshots = [];
                this.features.keypad.specialKeys = false;
            } else {
                this.dialpadSpecialKeysFeature = null;
                this.dialpadSpecialKeyReportingSnapshots = [];
                this.features.dialpad.specialKeys = false;
            }
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
        this.contextualDisplayCaps = null;
        this.contextualDisplayInfo = null;
        this.features.keypad.contextualDisplay = false;

        try {
            this.contextualDisplayFeature = new Feature19A1ContextualDisplay(hidppDevice);
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

        this.emit('rollerModeChanged', {
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
        const percent = brightnessToPercent(
            raw,
            this.brightnessInfo.minBrightness,
            this.brightnessInfo.maxBrightness
        );

        this.emit('brightnessChanged', { raw, percent });
        return { raw, percent };
    }

    async setBrightnessPercent(percent) {
        if (!this.brightnessFeature || !this.brightnessInfo) {
            throw new Error('Brightness feature is unavailable.');
        }

        const raw = percentToBrightness(
            percent,
            this.brightnessInfo.minBrightness,
            this.brightnessInfo.maxBrightness
        );

        await this.brightnessFeature.setBrightness(raw);
        return this.refreshBrightness();
    }

    async uploadContextualDisplayImage(file, options = {}) {
        if (!this.contextualDisplayFeature || !this.contextualDisplayInfo || !this.contextualDisplayCaps) {
            throw new Error('Feature 0x19A1 is not available on this device.');
        }

        const mode = options.mode || 'single';
        const keyNumber = Number(options.keyNumber || 1);
        const bitmap = await this.loadBitmapFromFile(file);

        try {
            if (mode === 'single') {
                if (!Number.isFinite(keyNumber) || keyNumber < 1 || keyNumber > 9) {
                    throw new Error('Select a valid key from 1 to 9.');
                }

                const button = this.contextualDisplayInfo.buttons[keyNumber - 1];
                if (!button) {
                    throw new Error(`Display button ${keyNumber} is not available on this device.`);
                }

                const encoded = await this.encodeAreaImage(bitmap, button.location.w, button.location.h);
                await this.contextualDisplayFeature.setImage(1, false, [{
                    imageFormat: encoded.imageFormat,
                    location: button.location,
                    imageData: encoded.imageData
                }]);

                this.emit('imageUploadComplete', { mode, keyNumber });
                return;
            }

            if (mode === 'all') {
                if (this.contextualDisplayInfo.buttons.length < 9) {
                    throw new Error(`Expected at least 9 buttons, got ${this.contextualDisplayInfo.buttons.length}.`);
                }

                for (let index = 0; index < 9; index++) {
                    const button = this.contextualDisplayInfo.buttons[index];
                    const encoded = await this.encodeAreaImage(bitmap, button.location.w, button.location.h);
                    const defer = index < 8;

                    await this.contextualDisplayFeature.setImage(1, defer, [{
                        imageFormat: encoded.imageFormat,
                        location: button.location,
                        imageData: encoded.imageData
                    }]);
                }

                this.emit('imageUploadComplete', { mode });
                return;
            }

            const fullWidth = this.contextualDisplayInfo.resHorizontal;
            const fullHeight = this.contextualDisplayInfo.resVertical;
            const encoded = await this.encodeAreaImage(bitmap, fullWidth, fullHeight);

            await this.contextualDisplayFeature.setImage(1, false, [{
                imageFormat: encoded.imageFormat,
                location: {
                    x: 0,
                    y: 0,
                    w: fullWidth,
                    h: fullHeight
                },
                imageData: encoded.imageData
            }]);

            this.emit('imageUploadComplete', { mode: 'full' });
        } finally {
            if (typeof bitmap.close === 'function') {
                bitmap.close();
            }
        }
    }

    async loadBitmapFromFile(file) {
        if (!file) {
            throw new Error('Select an image file first.');
        }

        if (!file.type.startsWith('image/')) {
            throw new Error('Selected file is not an image.');
        }

        try {
            return await createImageBitmap(file);
        } catch (_error) {
            const imageUrl = URL.createObjectURL(file);
            try {
                const image = new Image();
                await new Promise((resolve, reject) => {
                    image.onload = resolve;
                    image.onerror = () => reject(new Error('Failed to decode image file.'));
                    image.src = imageUrl;
                });

                const fallbackCanvas = document.createElement('canvas');
                fallbackCanvas.width = image.width;
                fallbackCanvas.height = image.height;
                const fallbackCtx = fallbackCanvas.getContext('2d');
                if (!fallbackCtx) {
                    throw new Error('Failed to create 2D canvas context.');
                }

                fallbackCtx.drawImage(image, 0, 0);
                return await createImageBitmap(fallbackCanvas);
            } finally {
                URL.revokeObjectURL(imageUrl);
            }
        }
    }

    createScaledCanvas(bitmap, targetWidth, targetHeight) {
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const context = canvas.getContext('2d', { alpha: false });
        if (!context) {
            throw new Error('Failed to create 2D canvas context.');
        }

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        return canvas;
    }

    async encodeAreaImage(bitmap, width, height) {
        if (!this.contextualDisplayCaps) {
            throw new Error('Contextual display capabilities are not available.');
        }

        const canvas = this.createScaledCanvas(bitmap, width, height);
        const caps = this.contextualDisplayCaps;

        if (caps.jpeg) {
            const qualities = [0.95, 0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25];
            for (const quality of qualities) {
                const jpegBlob = await canvasToBlob(canvas, 'image/jpeg', quality);
                if (jpegBlob.size <= caps.maxImageSize) {
                    return {
                        imageFormat: Feature19A1ContextualDisplay.ImageFormat.JPEG,
                        imageData: await blobToUint8Array(jpegBlob)
                    };
                }
            }
        }

        if (caps.rgb888) {
            const context = canvas.getContext('2d', { alpha: false });
            if (!context) {
                throw new Error('Failed to create RGB888 payload.');
            }

            const rgba = context.getImageData(0, 0, width, height).data;
            const rgb = new Uint8Array(width * height * 3);

            let writeIndex = 0;
            for (let i = 0; i < rgba.length; i += 4) {
                rgb[writeIndex++] = rgba[i];
                rgb[writeIndex++] = rgba[i + 1];
                rgb[writeIndex++] = rgba[i + 2];
            }

            if (rgb.length <= caps.maxImageSize) {
                return {
                    imageFormat: Feature19A1ContextualDisplay.ImageFormat.RGB888,
                    imageData: rgb
                };
            }
        }

        throw new Error('Could not encode image under device max image size with supported formats.');
    }

    handleRawVlpInputReport(role, event) {
        if (event.reportId !== RAW_VLP_REPORT_ID) {
            return;
        }

        const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
        if (data.length < 6) {
            return;
        }

        if (!(data[0] === 0xff && data[1] === 0x02 && data[2] === 0x00)) {
            return;
        }

        const keys = new Set();
        for (let i = 5; i < data.length; i++) {
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

            this.emit('keypadKeysChanged', {
                source,
                activeControlIds,
                activeLabels
            });
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

        this.emit('dialpadKeysChanged', {
            source,
            activeControlIds,
            activeLabels
        });
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
                progress: clampProgress(position / rollerIncrements),
                position,
                incrementsPerRotation: rollerIncrements
            };
        });
    }

    handleRotationEvent(rollerId, delta, timestamp) {
        this.rollerEventCount += 1;
        const snapshot = this.getRollerSnapshot(rollerId, delta);

        this.emit('rollerEvent', {
            rollerId,
            delta,
            timestamp,
            eventCount: this.rollerEventCount,
            snapshot
        });
    }

    clearRollerEvents() {
        this.rollerEventCount = 0;
        this.resetRollerPositions();
        this.emit('rollerCleared', {
            eventCount: this.rollerEventCount
        });
    }
}

export { ReportingMode };
