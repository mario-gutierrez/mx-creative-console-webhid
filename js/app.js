/**
 * Main application logic for the MX Creative Console WebHID monitor.
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
const DEBUG_LOGGING = true;

const KEYPAD_WIDGET_KEYS = [
    { controlId: 0x0001, label: '1' },
    { controlId: 0x0002, label: '2' },
    { controlId: 0x0003, label: '3' },
    { controlId: 0x0004, label: '4' },
    { controlId: 0x0005, label: '5' },
    { controlId: 0x0006, label: '6' },
    { controlId: 0x0007, label: '7' },
    { controlId: 0x0008, label: '8' },
    { controlId: 0x0009, label: '9' },
    { controlId: 0x01a1, label: 'PREV', wide: true },
    { controlId: 0x01a2, label: 'NEXT', wide: true }
];

const DIALPAD_WIDGET_KEYS = [
    { controlId: 0x0053, label: 'D1' },
    { controlId: 0x0056, label: 'D2' },
    { controlId: 0x0059, label: 'D3' },
    { controlId: 0x005A, label: 'D4' }
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

function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
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

function debugLog(...args) {
    if (DEBUG_LOGGING) {
        console.log('[mx-webhid]', ...args);
    }
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

class MultiRollerApp {
    constructor() {
        this.keypadConnection = null;
        this.dialpadConnection = null;
        this.multiRollerFeature = null;
        this.dialpadSpecialKeysFeature = null;
        this.keypadSpecialKeysFeature = null;
        this.brightnessFeature = null;
        this.contextualDisplayFeature = null;
        this.dialpadSpecialKeyReportingSnapshots = [];
        this.keypadSpecialKeyReportingSnapshots = [];
        this.availableDevices = [];

        this.supportsMultiRoller = false;
        this.supportsSpecialKeys = false;
        this.supportsBrightness = false;
        this.supportsContextualDisplay = false;

        this.keypadNormalPressedKeys = new Set();
        this.keypadDivertedPressedKeys = new Set();
        this.keypadPressedSpecialKeys = new Set();

        this.dialpadNormalPressedKeys = new Set();
        this.dialpadDivertedPressedKeys = new Set();
        this.dialpadPressedKeys = new Set();

        this.numRollers = 0;
        this.rollerCapabilities = [];
        this.rollerPositions = [];
        this.eventCount = 0;

        this.brightnessInfo = null;
        this.contextualDisplayCaps = null;
        this.contextualDisplayInfo = null;

        this.initializeUI();
        this.scanAuthorizedDevices().catch((error) => {
            console.error('Initial authorized device scan failed:', error);
        });
    }

    initializeUI() {
        this.connectBtn = document.getElementById('connectBtn');
        this.connectionStatus = document.getElementById('connectionStatus');
        this.availableDevicesSection = document.getElementById('availableDevicesSection');
        this.availableDevicesList = document.getElementById('availableDevicesList');

        this.keypadGroup = document.getElementById('keypadGroup');
        this.dialpadGroup = document.getElementById('dialpadGroup');
        this.keypadBadge = document.getElementById('keypadBadge');
        this.dialpadBadge = document.getElementById('dialpadBadge');

        this.eventsSection = document.getElementById('eventsSection');
        this.controlSection = document.getElementById('controlSection');
        this.keypadSection = document.getElementById('keypadSection');
        this.dialpadSection = document.getElementById('dialpadSection');
        this.brightnessSection = document.getElementById('brightnessSection');
        this.contextualDisplaySection = document.getElementById('contextualDisplaySection');

        this.currentMode = document.getElementById('currentMode');
        this.diversionStatus = document.getElementById('diversionStatus');
        this.diversionToggle = document.getElementById('diversionToggle');

        this.lastEventState = document.getElementById('lastEventState');

        this.keypadConsole = document.getElementById('keypadConsole');
        this.dialpadConsole = document.getElementById('dialpadConsole');

        this.brightnessCurrent = document.getElementById('brightnessCurrent');
        this.brightnessSlider = document.getElementById('brightnessSlider');

        this.contextualDisplaySupport = document.getElementById('contextualDisplaySupport');
        this.contextualDisplayResolution = document.getElementById('contextualDisplayResolution');
        this.contextualDisplayButtons = document.getElementById('contextualDisplayButtons');
        this.contextualDisplayFile = document.getElementById('contextualDisplayFile');
        this.contextualDisplayFileName = document.getElementById('contextualDisplayFileName');
        this.contextualDisplayMode = document.getElementById('contextualDisplayMode');
        this.contextualDisplayKey = document.getElementById('contextualDisplayKey');
        this.uploadContextualImageBtn = document.getElementById('uploadContextualImageBtn');

        this.connectBtn.onclick = async () => this.requestAndScanDevices();
        this.diversionToggle.addEventListener('change', () => this.onDiversionToggleChanged());
        document.getElementById('clearEventsBtn').addEventListener('click', () => this.clearEvents());
        document.getElementById('clearKeysBtn').addEventListener('click', () => this.clearKeyEvents());
        document.getElementById('clearDialpadKeysBtn').addEventListener('click', () => this.clearDialpadKeyEvents());

        this.brightnessSlider.addEventListener('change', () => {
            this.applyBrightness().catch((error) => {
                console.error('Apply brightness failed:', error);
                this.showStatus(`Error: ${error.message}`, true);
            });
        });

        this.contextualDisplayFile.addEventListener('change', () => {
            this.updateImageSelectionSummary();
        });

        this.contextualDisplayMode.addEventListener('change', () => {
            this.onImageModeChanged();
        });

        this.uploadContextualImageBtn.addEventListener('click', () => {
            this.uploadContextualDisplayImage().catch((error) => {
                console.error('Contextual display upload failed:', error);
                this.showStatus(`Error: ${error.message}`, true);
            });
        });

        this.diversionToggle.checked = false;
        this.diversionToggle.disabled = true;
        this.diversionStatus.textContent = 'Unavailable';

        this.setBrightnessUiEnabled(false);
        this.setContextualDisplayUiEnabled(false);
        this.onImageModeChanged();
        this.updateImageSelectionSummary();
    }

    showStatus(message, isError = false) {
        this.connectionStatus.textContent = message;
        this.connectionStatus.className = isError ? 'status-message error' : 'status-message success';
    }

    async onDiversionToggleChanged() {
        if (!this.supportsMultiRoller || !this.multiRollerFeature || this.numRollers === 0) {
            return;
        }

        const targetMode = this.diversionToggle.checked ? ReportingMode.Diverted : ReportingMode.Native;
        await this.setAllMode(targetMode);
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

    async probeFeatureSupport(hidppDevice, featureId) {
        try {
            if (featureId === FEATURE_ID_CONTEXTUAL_DISPLAY) {
                const probe = new Feature19A1ContextualDisplay(hidppDevice);
                try {
                    await probe.initialize();
                    debugLog('VLP-aware probe for 0x19A1 succeeded');
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
        let hidppDevice = null;
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

            hidppDevice = new HIDPP20Device(device);
            localInputReportHandler = hidppDevice.handleInputReport.bind(hidppDevice);
            device.addEventListener('inputreport', localInputReportHandler);

            supportsMultiRoller = await this.probeFeatureSupport(hidppDevice, FEATURE_ID_MULTIROLLER);
            supportsSpecialKeys = await this.probeFeatureSupport(hidppDevice, FEATURE_ID_SPECIAL_KEYS);
            supportsBrightness = await this.probeFeatureSupport(hidppDevice, FEATURE_ID_BRIGHTNESS);
            supportsContextualDisplay = await this.probeFeatureSupport(hidppDevice, FEATURE_ID_CONTEXTUAL_DISPLAY);

            debugLog('Feature probe', {
                productId: formatHex4(device.productId),
                supportsMultiRoller,
                supportsSpecialKeys,
                supportsBrightness,
                supportsContextualDisplay
            });

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

    async scanAuthorizedDevices() {
        const devices = await getAuthorizedDevices();
        const metadata = [];

        for (const device of devices) {
            metadata.push(await this.buildDeviceMetadata(device));
        }

        this.availableDevices = metadata.filter((entry) => entry.supportsAnyFeature);
        this.renderAvailableDevices();
    }

    async requestAndScanDevices() {
        try {
            this.showStatus('Requesting Logitech device permission...');

            if (!navigator.hid) {
                throw new Error('WebHID is not supported in this browser. Please use Chrome, Edge, or Opera.');
            }

            await requestLogitechDevices();
            await this.scanAuthorizedDevices();

            if (this.availableDevices.length === 0) {
                this.showStatus('No authorized MX Creative-compatible devices were found.', true);
                return;
            }

            this.showStatus('Select a device from the list to connect.');
        } catch (error) {
            console.error('Device permission error:', error);
            this.showStatus(`Error: ${error.message}`, true);
        }
    }

    renderAvailableDevices() {
        this.availableDevicesList.innerHTML = '';

        if (this.availableDevices.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'available-device-empty';
            emptyState.textContent = 'No authorized MX Creative devices yet. Click "Scan / Grant Devices".';
            this.availableDevicesList.appendChild(emptyState);
            this.availableDevicesSection.classList.remove('hidden');
            return;
        }

        this.availableDevices.forEach((entry, index) => {
            const card = document.createElement('div');
            card.className = 'available-device-card';
            const role = this.classifyDeviceRole(entry);

            const features = [];
            if (entry.supportsMultiRoller) {
                features.push('0x4610');
            }
            if (entry.supportsSpecialKeys) {
                features.push('0x1B04');
            }
            if (entry.supportsBrightness) {
                features.push('0x8040');
            }
            if (entry.supportsContextualDisplay) {
                features.push('0x19A1');
            }

            const details = document.createElement('div');
            details.className = 'available-device-details';
            details.innerHTML = `
                <div class="available-device-title">${entry.friendlyName}</div>
                <div class="available-device-meta">Name source: ${entry.nameSource}</div>
                <div class="available-device-meta">PID: ${formatHex4(entry.productId)} | VID: ${formatHex4(entry.vendorId)}</div>
                <div class="available-device-meta">Features: ${features.join(', ') || 'None detected'}</div>
                <div class="available-device-meta">Browser name: ${entry.productName}</div>
            `;

            const action = document.createElement('button');
            action.className = 'secondary-btn';
            const hasRoleConnection = role === 'keypad' ? Boolean(this.keypadConnection) : Boolean(this.dialpadConnection);
            action.textContent = hasRoleConnection ? `Replace ${role}` : `Connect ${role}`;
            action.addEventListener('click', () => this.connectToAvailableDevice(index));

            card.appendChild(details);
            card.appendChild(action);
            this.availableDevicesList.appendChild(card);
        });

        this.availableDevicesSection.classList.remove('hidden');
    }

    async connectToAvailableDevice(index) {
        if (index < 0 || index >= this.availableDevices.length) {
            this.showStatus('Invalid device selection.', true);
            return;
        }

        const deviceEntry = this.availableDevices[index];
        const role = this.classifyDeviceRole(deviceEntry);

        await this.connectDevice(role, deviceEntry);
    }

    createRawInputReportHandler(role) {
        return (event) => this.handleRawVlpInputReport(role, event);
    }

    createSpecialKeyHandler(role) {
        return (controlIds) => this.handleSpecialKeyChange(role, controlIds);
    }

    async connectDevice(role, deviceEntry) {
        try {
            await this.disconnectRole(role);

            this.showStatus(`Opening selected ${role} device...`);
            debugLog('Connecting device', {
                role,
                friendlyName: deviceEntry.friendlyName,
                productId: formatHex4(deviceEntry.productId),
                vendorId: formatHex4(deviceEntry.vendorId)
            });

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

            if (role === 'keypad') {
                this.keypadConnection = connection;
                this.keypadBadge.textContent = 'Connected';
            } else {
                this.dialpadConnection = connection;
                this.dialpadBadge.textContent = 'Connected';
            }

            this.showStatus(`Initializing ${role} monitor features...`);

            if (role === 'dialpad') {
                await this.initializeRollers(hidppDevice);
                await this.initializeSpecialKeys('dialpad', hidppDevice, connection.specialKeyHandler);

                this.dialpadGroup.classList.remove('hidden');
                this.dialpadSection.classList.remove('hidden');

                if (this.supportsMultiRoller && this.numRollers > 0) {
                    this.eventsSection.classList.remove('hidden');
                    this.controlSection.classList.remove('hidden');
                    this.diversionToggle.disabled = false;
                    await this.setAllMode(ReportingMode.Diverted);
                } else {
                    this.eventsSection.classList.add('hidden');
                    this.controlSection.classList.add('hidden');
                    this.diversionToggle.checked = false;
                    this.diversionToggle.disabled = true;
                    this.diversionStatus.textContent = 'Unavailable';
                    this.currentMode.textContent = 'Unavailable';
                }
            } else {
                await this.initializeSpecialKeys('keypad', hidppDevice, connection.specialKeyHandler);
                await this.initializeContextualDisplay(hidppDevice);
                await this.initializeBrightness(hidppDevice);

                this.keypadGroup.classList.remove('hidden');
                this.keypadSection.classList.remove('hidden');
                this.contextualDisplaySection.classList.remove('hidden');

                if (this.supportsBrightness) {
                    this.brightnessSection.classList.remove('hidden');
                    await this.refreshBrightness();
                } else {
                    this.brightnessSection.classList.add('hidden');
                }
            }

            this.showStatus(`${role} connected successfully.`);
        } catch (error) {
            console.error('Connection error:', error);
            this.showStatus(`Error: ${error.message}`, true);
            await this.disconnectRole(role);
        }
    }

    async initializeRollers(hidppDevice) {
        this.multiRollerFeature = null;
        this.supportsMultiRoller = false;
        this.numRollers = 0;
        this.rollerCapabilities = [];
        this.rollerPositions = [];

        try {
            this.multiRollerFeature = new Feature4610MultiRoller(hidppDevice);
            await this.multiRollerFeature.initialize();

            this.numRollers = await this.multiRollerFeature.getCapabilities();

            for (let i = 0; i < this.numRollers; i++) {
                const caps = await this.multiRollerFeature.getRollerCapabilities(i);
                this.rollerCapabilities.push(caps);
            }

            this.supportsMultiRoller = this.numRollers > 0;

            if (this.supportsMultiRoller) {
                this.resetRollerPositions();
                this.renderLastEventState(null, 'Waiting for rotation events...', 'Roll the diverted wheels to update the monitor.');
                this.displayRollerCapabilities();

                this.multiRollerFeature.onRotationEvent((rollerId, delta, timestamp) => {
                    this.handleRotationEvent(rollerId, delta, timestamp);
                });
            }
        } catch (_error) {
            this.multiRollerFeature = null;
            this.supportsMultiRoller = false;
            this.numRollers = 0;
        }
    }

    async initializeSpecialKeys(role, hidppDevice, keyHandler) {
        this.supportsSpecialKeys = false;

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
            } else {
                this.dialpadSpecialKeysFeature = feature;
                this.dialpadSpecialKeyReportingSnapshots = snapshots;
            }

            this.supportsSpecialKeys = true;
        } catch (_error) {
            if (role === 'keypad') {
                this.keypadSpecialKeysFeature = null;
                this.keypadSpecialKeyReportingSnapshots = [];
            } else {
                this.dialpadSpecialKeysFeature = null;
                this.dialpadSpecialKeyReportingSnapshots = [];
            }

            this.supportsSpecialKeys = false;
        }
    }

    async initializeBrightness(hidppDevice) {
        this.brightnessFeature = null;
        this.brightnessInfo = null;
        this.supportsBrightness = false;
        this.setBrightnessUiEnabled(false);

        try {
            this.brightnessFeature = new Feature8040BrightnessControl(hidppDevice);
            await this.brightnessFeature.initialize();
            this.brightnessInfo = await this.brightnessFeature.getInfo();
            this.supportsBrightness = true;
            this.setBrightnessUiEnabled(true);
        } catch (_error) {
            this.brightnessFeature = null;
            this.brightnessInfo = null;
            this.supportsBrightness = false;
            this.setBrightnessUiEnabled(false);
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

            this.supportsContextualDisplay = false;
            this.contextualDisplayFeature = null;
            this.contextualDisplayCaps = null;
            this.contextualDisplayInfo = null;
            this.contextualDisplaySupport.textContent = 'Unavailable';
            this.contextualDisplayResolution.textContent = '-';
            this.contextualDisplayButtons.textContent = '-';
            this.contextualDisplayFile.value = '';
            this.setContextualDisplayUiEnabled(false);
            this.onImageModeChanged();
            this.updateImageSelectionSummary();

            this.supportsBrightness = false;
            this.brightnessFeature = null;
            this.brightnessInfo = null;
            this.brightnessSection.classList.add('hidden');

            this.keypadSection.classList.add('hidden');
            this.contextualDisplaySection.classList.add('hidden');
            this.keypadBadge.textContent = 'Disconnected';
            this.keypadGroup.classList.add('hidden');
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
                    } catch (error) {
                        console.error(`Error restoring roller ${i}:`, error);
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
            this.supportsMultiRoller = false;
            this.numRollers = 0;
            this.rollerCapabilities = [];
            this.rollerPositions = [];
            this.eventCount = 0;

            this.renderLastEventState(null, 'No event received.', 'Connect a dialpad to resume monitoring.');

            this.eventsSection.classList.add('hidden');
            this.controlSection.classList.add('hidden');
            this.dialpadSection.classList.add('hidden');
            this.dialpadBadge.textContent = 'Disconnected';

            this.diversionToggle.checked = false;
            this.diversionToggle.disabled = true;
            this.diversionStatus.textContent = 'Unavailable';
            this.currentMode.textContent = '-';
            this.dialpadGroup.classList.add('hidden');
        }
    }

    setBrightnessUiEnabled(enabled) {
        this.brightnessSlider.disabled = !enabled;
    }

    async applyBrightness() {
        if (!this.supportsBrightness || !this.brightnessFeature || !this.brightnessInfo) {
            return;
        }

        const requestedPercent = Math.round(Math.max(0, Math.min(100, Number(this.brightnessSlider.value))));
        const raw = percentToBrightness(
            requestedPercent,
            this.brightnessInfo.minBrightness,
            this.brightnessInfo.maxBrightness
        );

        await this.brightnessFeature.setBrightness(raw);
        await this.refreshBrightness();
    }

    async refreshBrightness() {
        if (!this.supportsBrightness || !this.brightnessFeature || !this.brightnessInfo) {
            return;
        }

        const raw = await this.brightnessFeature.getBrightness();
        const percent = brightnessToPercent(
            raw,
            this.brightnessInfo.minBrightness,
            this.brightnessInfo.maxBrightness
        );

        this.brightnessCurrent.textContent = String(percent);
        this.brightnessSlider.value = String(percent);
    }

    async initializeContextualDisplay(hidppDevice) {
        this.contextualDisplayFeature = null;
        this.contextualDisplayCaps = null;
        this.contextualDisplayInfo = null;
        this.supportsContextualDisplay = false;

        this.contextualDisplaySupport.textContent = 'Unavailable';
        this.contextualDisplayResolution.textContent = '-';
        this.contextualDisplayButtons.textContent = '-';
        this.contextualDisplayFile.value = '';
        this.contextualDisplayMode.value = 'single';
        this.contextualDisplayKey.value = '1';
        this.setContextualDisplayUiEnabled(false);
        this.onImageModeChanged();
        this.updateImageSelectionSummary();

        debugLog('Initializing Feature 0x19A1 contextual display...');

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
            this.supportsContextualDisplay = true;

            this.contextualDisplaySupport.textContent = `Feature 0x19A1 available (max image size ${caps.maxImageSize} bytes)`;
            this.contextualDisplayResolution.textContent = `${displayInfo.resHorizontal} x ${displayInfo.resVertical}`;
            this.contextualDisplayButtons.textContent = String(displayInfo.buttons.length);
            this.setContextualDisplayUiEnabled(true);

            debugLog('Feature 0x19A1 ready', {
                caps,
                displayInfo
            });
        } catch (_error) {
            if (this.contextualDisplayFeature) {
                this.contextualDisplayFeature.close();
            }

            this.contextualDisplayFeature = null;
            this.contextualDisplayCaps = null;
            this.contextualDisplayInfo = null;
            this.supportsContextualDisplay = false;

            this.contextualDisplaySupport.textContent = 'Feature 0x19A1 unavailable (see console logs)';
            this.setContextualDisplayUiEnabled(false);

            console.error('[mx-webhid] Feature 0x19A1 init failed:', _error);
        }
    }

    setContextualDisplayUiEnabled(enabled) {
        this.contextualDisplayFile.disabled = !enabled;
        this.contextualDisplayMode.disabled = !enabled;
        this.contextualDisplayKey.disabled = !enabled || this.contextualDisplayMode.value !== 'single';
        this.uploadContextualImageBtn.disabled = !enabled;
    }

    onImageModeChanged() {
        const isSingle = this.contextualDisplayMode.value === 'single';
        this.contextualDisplayKey.disabled = !isSingle || !this.supportsContextualDisplay;
    }

    updateImageSelectionSummary() {
        const selectedFile = this.contextualDisplayFile.files?.[0];
        if (!selectedFile) {
            this.contextualDisplayFileName.textContent = 'No image selected';
            return;
        }

        this.contextualDisplayFileName.textContent = `${selectedFile.name} (${selectedFile.type || 'unknown'}, ${selectedFile.size} bytes)`;
    }

    async loadBitmapFromSelectedImage() {
        const selectedFile = this.contextualDisplayFile.files?.[0];
        if (!selectedFile) {
            throw new Error('Select an image file first.');
        }

        if (!selectedFile.type.startsWith('image/')) {
            throw new Error('Selected file is not an image.');
        }

        try {
            return await createImageBitmap(selectedFile);
        } catch (_error) {
            const imageUrl = URL.createObjectURL(selectedFile);
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

    async uploadContextualDisplayImage() {
        if (!this.supportsContextualDisplay || !this.contextualDisplayFeature || !this.contextualDisplayInfo) {
            throw new Error('Feature 0x19A1 is not available on this device.');
        }

        const mode = this.contextualDisplayMode.value;
        const bitmap = await this.loadBitmapFromSelectedImage();

        try {
            if (mode === 'single') {
                const keyNumber = Number(this.contextualDisplayKey.value);
                if (!Number.isFinite(keyNumber) || keyNumber < 1 || keyNumber > 9) {
                    throw new Error('Select a valid key from 1 to 9.');
                }

                const button = this.contextualDisplayInfo.buttons[keyNumber - 1];
                if (!button) {
                    throw new Error(`Display button ${keyNumber} is not available on this device.`);
                }

                this.showStatus(`Uploading image to key ${keyNumber}...`);

                const encoded = await this.encodeAreaImage(bitmap, button.location.w, button.location.h);

                await this.contextualDisplayFeature.setImage(1, false, [{
                    imageFormat: encoded.imageFormat,
                    location: button.location,
                    imageData: encoded.imageData
                }]);

                this.showStatus(`Updated key ${keyNumber} successfully.`);
                return;
            }

            if (mode === 'all') {
                if (this.contextualDisplayInfo.buttons.length < 9) {
                    throw new Error(`Expected at least 9 buttons, got ${this.contextualDisplayInfo.buttons.length}.`);
                }

                this.showStatus('Uploading image to all keypad keys...');

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

                this.showStatus('Updated all 9 keys successfully.');
                return;
            }

            this.showStatus('Uploading full-display image...');

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

            this.showStatus('Updated full keypad display successfully.');
        } finally {
            if (typeof bitmap.close === 'function') {
                bitmap.close();
            }
        }
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

        debugLog('Raw 0x13 keys', Array.from(keys).map((key) => `0x${key.toString(16).padStart(2, '0')}`));
        this.syncUnifiedPressedKeys(role, 'Raw 0x13 update received');
    }

    handleSpecialKeyChange(role, controlIds) {
        if (role === 'keypad') {
            this.keypadDivertedPressedKeys.clear();
        } else {
            this.dialpadDivertedPressedKeys.clear();
        }

        debugLog('Feature 1B04 diverted controlIds', controlIds.map((id) => formatHex4(id)));

        for (const controlId of controlIds) {
            if (controlId !== 0) {
                if (role === 'keypad') {
                    this.keypadDivertedPressedKeys.add(controlId);
                } else {
                    this.dialpadDivertedPressedKeys.add(controlId);
                }
            }
        }

        this.syncUnifiedPressedKeys(role, 'Feature 1B04 key state changed');
    }

    syncUnifiedPressedKeys(role, statusText) {
        if (role === 'keypad') {
            this.keypadPressedSpecialKeys.clear();

            for (const keyId of this.keypadNormalPressedKeys) {
                if (!DIALPAD_WIDGET_KEYS.some((key) => (key.controlId & 0xff) === keyId)) {
                    this.keypadPressedSpecialKeys.add(keyId);
                }
            }

            for (const keyId of this.keypadDivertedPressedKeys) {
                if (!DIALPAD_WIDGET_KEYS.some((key) => key.controlId === keyId)) {
                    this.keypadPressedSpecialKeys.add(keyId);
                }
            }

            debugLog('Keypad pressed state', {
                statusText,
                normalPressed: Array.from(this.keypadNormalPressedKeys).map((id) => formatHex4(id)),
                divertedPressed: Array.from(this.keypadDivertedPressedKeys).map((id) => formatHex4(id)),
                keypadPressed: Array.from(this.keypadPressedSpecialKeys).map((id) => formatHex4(id))
            });

            this.renderKeypadWidget();
            return;
        }

        this.dialpadPressedKeys.clear();

        const dialControlIds = new Set(DIALPAD_WIDGET_KEYS.map((key) => key.controlId));
        const dialLowByteIds = new Set(DIALPAD_WIDGET_KEYS.map((key) => key.controlId & 0xff));

        for (const keyId of this.dialpadNormalPressedKeys) {
            // Raw 0x13 key IDs are single byte values (for dial keys these are low bytes like 0x53).
            if (dialControlIds.has(keyId) || dialLowByteIds.has(keyId)) {
                this.dialpadPressedKeys.add(keyId);
            }
        }

        for (const keyId of this.dialpadDivertedPressedKeys) {
            if (DIALPAD_WIDGET_KEYS.some(k => k.controlId === keyId)) {
                this.dialpadPressedKeys.add(keyId);
            }
        }

        debugLog('Dialpad pressed state', {
            statusText,
            normalPressed: Array.from(this.dialpadNormalPressedKeys).map((id) => formatHex4(id)),
            divertedPressed: Array.from(this.dialpadDivertedPressedKeys).map((id) => formatHex4(id)),
            dialPressed: Array.from(this.dialpadPressedKeys).map((id) => formatHex4(id))
        });

        this.renderDialpadKeysCompact();
    }

    renderKeypadWidget() {
        const activeKeys = KEYPAD_WIDGET_KEYS
            .filter((key) => this.keypadPressedSpecialKeys.has(key.controlId))
            .map((key) => key.label);

        const stateStr = activeKeys.join(',');
        if (stateStr === this._lastKeypadConsoleState) {
            return;
        }
        this._lastKeypadConsoleState = stateStr;

        const timestamp = new Date().toLocaleTimeString();
        const line = activeKeys.length === 0
            ? `[${timestamp}] — released all`
            : `[${timestamp}] Active: ${activeKeys.join(', ')}`;

        this.keypadConsole.value += line + '\n';
        this.keypadConsole.scrollTop = this.keypadConsole.scrollHeight;
    }

    clearKeyEvents() {
        this.keypadNormalPressedKeys.clear();
        this.keypadDivertedPressedKeys.clear();
        this.keypadPressedSpecialKeys.clear();
        this._lastKeypadConsoleState = null;
        this.keypadConsole.value = '';
    }

    clearDialpadKeyEvents() {
        this.dialpadNormalPressedKeys.clear();
        this.dialpadDivertedPressedKeys.clear();
        this.dialpadPressedKeys.clear();
        this._lastDialpadConsoleState = null;
        this.dialpadConsole.value = '';
    }

    renderDialpadKeysCompact() {
        const activeKeys = DIALPAD_WIDGET_KEYS
            .filter((key) => this.dialpadPressedKeys.has(key.controlId) || this.dialpadPressedKeys.has(key.controlId & 0xff))
            .map((key) => key.label);

        const stateStr = activeKeys.join(',');
        if (stateStr === this._lastDialpadConsoleState) {
            return;
        }
        this._lastDialpadConsoleState = stateStr;

        const timestamp = new Date().toLocaleTimeString();
        const line = activeKeys.length === 0
            ? `[${timestamp}] — released all`
            : `[${timestamp}] Active: ${activeKeys.join(', ')}`;

        this.dialpadConsole.value += line + '\n';
        this.dialpadConsole.scrollTop = this.dialpadConsole.scrollHeight;
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

    buildRollerSnapshotMarkup(snapshot) {
        return snapshot.map((roller) => {
            const progressDegrees = `${Math.round(roller.progress * 360)}deg`;
            const progressPercent = `${Math.round(roller.progress * 100)}%`;
            const classes = [
                'event-wheel',
                roller.available ? '' : 'disabled',
                roller.isChanged ? 'changed' : '',
                `direction-${roller.directionClass}`
            ].filter(Boolean).join(' ');

            return `
                <div class="event-wheel-wrap">
                    <div class="${classes}" style="--wheel-progress:${progressDegrees};">
                        <span class="event-wheel-core"></span>
                    </div>
                    <span class="event-wheel-label">R${roller.rollerId} ${progressPercent}</span>
                </div>
            `;
        }).join('');
    }

    renderLastEventState(snapshot = null, statusText = 'Waiting for rotation events...', detailText = 'Live monitor is idle.') {
        if (!this.lastEventState) {
            return;
        }

        const effectiveSnapshot = snapshot || [0, 1].map((rollerId) => {
            const rollerCapability = this.getRollerCapability(rollerId);
            const incrementsPerRotation = rollerCapability?.incrementsPerRotation || 1;
            const position = ((this.rollerPositions[rollerId] || 0) % incrementsPerRotation + incrementsPerRotation) % incrementsPerRotation;

            return {
                rollerId,
                available: Boolean(rollerCapability),
                isChanged: false,
                directionClass: 'idle',
                progress: clampProgress(position / incrementsPerRotation),
                position,
                incrementsPerRotation
            };
        });

        const eventNumber = this.eventCount === 0 ? '--' : `#${this.eventCount}`;

        this.lastEventState.innerHTML = `
            <div class="event-item persistent ${this.eventCount === 0 ? 'is-empty' : ''}">
                <div class="event-summary">
                    <span class="event-number">${eventNumber}</span>
                    <span class="event-status-label">Latest signal</span>
                </div>
                <div class="event-visuals">${this.buildRollerSnapshotMarkup(effectiveSnapshot)}</div>
                <div class="event-status-block">
                    <span class="event-roller">${escapeHtml(statusText)}</span>
                    <span class="event-detail">${escapeHtml(detailText)}</span>
                </div>
            </div>
        `;
    }

    displayRollerCapabilities() {
        // Roller capabilities section removed from UI.
    }

    async updateRollerMode(rollerId) {
        // Roller mode display removed from UI.
    }

    async refreshAllRollerModes() {
        for (const roller of this.rollerCapabilities) {
            await this.updateRollerMode(roller.rollerId);
        }
    }

    async setAllMode(mode) {
        if (!this.multiRollerFeature || this.rollerCapabilities.length === 0) {
            return;
        }

        try {
            const modeStr = Feature4610MultiRoller.getModeString(mode);
            this.showStatus(`Setting all rollers to ${modeStr} mode...`);

            for (const roller of this.rollerCapabilities) {
                await this.multiRollerFeature.setMode(roller.rollerId, mode);
            }

            await this.refreshAllRollerModes();

            this.currentMode.textContent = modeStr;
            this.diversionToggle.checked = mode === ReportingMode.Diverted;
            this.diversionStatus.textContent = mode === ReportingMode.Diverted ? 'On (Diverted)' : 'Off (Native)';
            this.showStatus(`All rollers set to ${modeStr} mode`);

            if (mode === ReportingMode.Diverted) {
                this.renderLastEventState(null, 'Rollers in Diverted mode.', 'Rotate either wheel to update the live monitor.');
            } else {
                this.renderLastEventState(null, 'Rollers in Native mode.', 'Enable diversion to receive wheel rotation events.');
            }
        } catch (error) {
            console.error('Error setting mode:', error);
            this.showStatus(`Error: ${error.message}`, true);
        }
    }

    handleRotationEvent(rollerId, delta, timestamp) {
        this.eventCount++;
        const snapshot = this.getRollerSnapshot(rollerId, delta);
        const deltaPrefix = delta > 0 ? '+' : '';

        this.renderLastEventState(
            snapshot,
            `R${rollerId} ${deltaPrefix}${delta}`,
            `${timestamp}ms | ${new Date().toLocaleTimeString()}`
        );
    }

    clearEvents() {
        this.eventCount = 0;
        this.resetRollerPositions();
        this.renderLastEventState(null, 'No event received.', 'Wheel progress reset to empty.');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new MultiRollerApp());
} else {
    new MultiRollerApp();
}
