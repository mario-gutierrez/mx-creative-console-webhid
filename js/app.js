/**
 * Demo page integration for MXCreativeConsoleClient.
 */

import { MXCreativeConsoleClient } from './mxCreativeConsole.js';

function formatHex4(value) {
    return `0x${value.toString(16).padStart(4, '0').toUpperCase()}`;
}

function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

class MonitorDemoApp {
    constructor() {
        this.client = new MXCreativeConsoleClient({ debug: true });

        this.lastKeypadState = null;
        this.lastDialpadState = null;
        this.supportsContextualDisplay = false;

        this.connectBtn = document.getElementById('connectBtn');
        this.connectionStatus = document.getElementById('connectionStatus');
        this.availableDevicesSection = document.getElementById('availableDevicesSection');
        this.availableDevicesList = document.getElementById('availableDevicesList');

        this.keypadGroup = document.getElementById('keypadGroup');
        this.dialpadGroup = document.getElementById('dialpadGroup');
        this.keypadBadge = document.getElementById('keypadBadge');
        this.dialpadBadge = document.getElementById('dialpadBadge');

        this.keypadSection = document.getElementById('keypadSection');
        this.dialpadSection = document.getElementById('dialpadSection');
        this.contextualDisplaySection = document.getElementById('contextualDisplaySection');
        this.brightnessSection = document.getElementById('brightnessSection');

        this.eventsSection = document.getElementById('eventsSection');
        this.controlSection = document.getElementById('controlSection');
        this.lastEventState = document.getElementById('lastEventState');
        this.diversionToggle = document.getElementById('diversionToggle');
        this.currentMode = document.getElementById('currentMode');
        this.diversionStatus = document.getElementById('diversionStatus');

        this.keypadConsole = document.getElementById('keypadConsole');
        this.dialpadConsole = document.getElementById('dialpadConsole');

        this.brightnessSlider = document.getElementById('brightnessSlider');
        this.brightnessCurrent = document.getElementById('brightnessCurrent');

        this.contextualDisplaySupport = document.getElementById('contextualDisplaySupport');
        this.contextualDisplayResolution = document.getElementById('contextualDisplayResolution');
        this.contextualDisplayButtons = document.getElementById('contextualDisplayButtons');
        this.contextualDisplayFile = document.getElementById('contextualDisplayFile');
        this.contextualDisplayFileName = document.getElementById('contextualDisplayFileName');
        this.contextualDisplayMode = document.getElementById('contextualDisplayMode');
        this.contextualDisplayKey = document.getElementById('contextualDisplayKey');
        this.uploadContextualImageBtn = document.getElementById('uploadContextualImageBtn');

        this.bindUi();
        this.bindClientEvents();

        this.refreshUiFromState();
        this.updateImageSelectionSummary();
        this.renderLastEventState();
        this.client.scanAuthorizedDevices().catch((error) => {
            this.showStatus(`Error: ${error.message}`, true);
        });
    }

    bindUi() {
        this.connectBtn.addEventListener('click', async () => {
            try {
                await this.client.requestDeviceAccessAndScan();
            } catch (error) {
                this.showStatus(`Error: ${error.message}`, true);
            }
        });

        this.diversionToggle.addEventListener('change', async () => {
            try {
                await this.client.setRollerDiverted(this.diversionToggle.checked);
            } catch (error) {
                this.showStatus(`Error: ${error.message}`, true);
            }
        });

        document.getElementById('clearEventsBtn').addEventListener('click', () => {
            this.client.clearRollerEvents();
            this.renderLastEventState(null, 'No event received.', 'Wheel progress reset to empty.', 0);
        });

        document.getElementById('clearKeysBtn').addEventListener('click', () => {
            this.keypadConsole.value = '';
            this.lastKeypadState = null;
        });

        document.getElementById('clearDialpadKeysBtn').addEventListener('click', () => {
            this.dialpadConsole.value = '';
            this.lastDialpadState = null;
        });

        this.brightnessSlider.addEventListener('change', async () => {
            try {
                await this.client.setBrightnessPercent(Number(this.brightnessSlider.value));
            } catch (error) {
                this.showStatus(`Error: ${error.message}`, true);
            }
        });

        this.contextualDisplayFile.addEventListener('change', () => {
            this.updateImageSelectionSummary();
        });

        this.contextualDisplayMode.addEventListener('change', () => {
            this.onImageModeChanged();
        });

        this.uploadContextualImageBtn.addEventListener('click', async () => {
            const file = this.contextualDisplayFile.files?.[0];
            const mode = this.contextualDisplayMode.value;
            const keyNumber = Number(this.contextualDisplayKey.value);

            try {
                await this.client.uploadContextualDisplayImage(file, { mode, keyNumber });
                this.showStatus('Image uploaded successfully.');
            } catch (error) {
                this.showStatus(`Error: ${error.message}`, true);
            }
        });
    }

    bindClientEvents() {
        this.client.on('status', ({ message, isError }) => {
            this.showStatus(message, isError);
        });

        this.client.on('devicesChanged', (devices) => {
            this.renderAvailableDevices(devices);
        });

        this.client.on('roleConnected', async ({ role }) => {
            this.refreshUiFromState();
            if (role === 'dialpad' && !this.diversionToggle.disabled) {
                try {
                    await this.client.setRollerDiverted(true);
                } catch (_error) {
                    // Keep connection usable if auto-divert fails.
                }
            }
        });

        this.client.on('roleDisconnected', () => {
            this.refreshUiFromState();
        });

        this.client.on('stateChanged', () => {
            this.refreshUiFromState();
        });

        this.client.on('brightnessChanged', ({ percent }) => {
            this.brightnessCurrent.textContent = String(percent);
            this.brightnessSlider.value = String(percent);
        });

        this.client.on('rollerModeChanged', ({ modeName, diverted }) => {
            this.currentMode.textContent = modeName;
            this.diversionStatus.textContent = diverted ? 'On (Diverted)' : 'Off (Native)';
            this.diversionToggle.checked = diverted;

            if (diverted) {
                this.renderLastEventState(null, 'Rollers in Diverted mode.', 'Rotate either wheel to update the live monitor.', 0);
            } else {
                this.renderLastEventState(null, 'Rollers in Native mode.', 'Enable diversion to receive wheel rotation events.', 0);
            }
        });

        this.client.on('rollerEvent', ({ rollerId, delta, timestamp, snapshot, eventCount }) => {
            const deltaPrefix = delta > 0 ? '+' : '';
            this.renderLastEventState(
                snapshot,
                `R${rollerId} ${deltaPrefix}${delta}`,
                `${timestamp}ms | ${new Date().toLocaleTimeString()}`,
                eventCount
            );
        });

        this.client.on('keypadKeysChanged', ({ activeLabels }) => {
            const state = activeLabels.join(',');
            if (state === this.lastKeypadState) {
                return;
            }

            this.lastKeypadState = state;
            this.appendConsoleLine(
                this.keypadConsole,
                activeLabels.length === 0 ? 'released all' : `Active: ${activeLabels.join(', ')}`
            );
        });

        this.client.on('dialpadKeysChanged', ({ activeLabels }) => {
            const state = activeLabels.join(',');
            if (state === this.lastDialpadState) {
                return;
            }

            this.lastDialpadState = state;
            this.appendConsoleLine(
                this.dialpadConsole,
                activeLabels.length === 0 ? 'released all' : `Active: ${activeLabels.join(', ')}`
            );
        });
    }

    showStatus(message, isError = false) {
        this.connectionStatus.textContent = message;
        this.connectionStatus.className = isError ? 'status-message error' : 'status-message success';
    }
    renderAvailableDevices(devices) {
        this.availableDevicesList.innerHTML = '';

        if (devices.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'available-device-empty';
            emptyState.textContent = 'No authorized MX Creative devices yet. Click "Scan / Grant Devices".';
            this.availableDevicesList.appendChild(emptyState);
            this.availableDevicesSection.classList.remove('hidden');
            return;
        }

        devices.forEach((entry, index) => {
            const card = document.createElement('div');
            card.className = 'available-device-card';
            const role = entry.role;

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
            const state = this.client.getConnectionState();
            const hasRoleConnection = role === 'keypad' ? state.keypadConnected : state.dialpadConnected;
            action.textContent = hasRoleConnection ? `Replace ${role}` : `Connect ${role}`;
            action.addEventListener('click', async () => {
                try {
                    await this.client.connectAvailableDevice(index);
                } catch (error) {
                    this.showStatus(`Error: ${error.message}`, true);
                }
            });

            card.appendChild(details);
            card.appendChild(action);
            this.availableDevicesList.appendChild(card);
        });

        this.availableDevicesSection.classList.remove('hidden');
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
    refreshUiFromState() {
        const state = this.client.getConnectionState();
        this.supportsContextualDisplay = state.features.keypad.contextualDisplay;

        this.keypadBadge.textContent = state.keypadConnected ? 'Connected' : 'Disconnected';
        this.dialpadBadge.textContent = state.dialpadConnected ? 'Connected' : 'Disconnected';

        this.keypadGroup.classList.toggle('hidden', !state.keypadConnected);
        this.keypadSection.classList.toggle('hidden', !state.keypadConnected);
        this.contextualDisplaySection.classList.toggle('hidden', !state.keypadConnected || !state.features.keypad.contextualDisplay);
        this.brightnessSection.classList.toggle('hidden', !state.keypadConnected || !state.features.keypad.brightness);

        this.dialpadGroup.classList.toggle('hidden', !state.dialpadConnected);
        this.dialpadSection.classList.toggle('hidden', !state.dialpadConnected);
        this.eventsSection.classList.toggle('hidden', !state.dialpadConnected || !state.features.dialpad.multiRoller);
        this.controlSection.classList.toggle('hidden', !state.dialpadConnected || !state.features.dialpad.multiRoller);

        this.diversionToggle.disabled = !state.features.dialpad.multiRoller;
        if (!state.features.dialpad.multiRoller) {
            this.currentMode.textContent = 'Unavailable';
            this.diversionStatus.textContent = 'Unavailable';
        }

        if (state.features.keypad.contextualDisplay && state.contextualDisplayCaps && state.contextualDisplayInfo) {
            this.contextualDisplaySupport.textContent = `Feature 0x19A1 available (max image size ${state.contextualDisplayCaps.maxImageSize} bytes)`;
            this.contextualDisplayResolution.textContent = `${state.contextualDisplayInfo.resHorizontal} x ${state.contextualDisplayInfo.resVertical}`;
            this.contextualDisplayButtons.textContent = String(state.contextualDisplayInfo.buttons.length);
        } else {
            this.contextualDisplaySupport.textContent = 'Feature 0x19A1 unavailable';
            this.contextualDisplayResolution.textContent = '-';
            this.contextualDisplayButtons.textContent = '-';
        }

        this.setContextualDisplayUiEnabled(state.features.keypad.contextualDisplay);
        this.brightnessSlider.disabled = !state.features.keypad.brightness;
        this.onImageModeChanged();
    }

    appendConsoleLine(textarea, text) {
        const timestamp = new Date().toLocaleTimeString();
        textarea.value += `[${timestamp}] ${text}\n`;
        textarea.scrollTop = textarea.scrollHeight;
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

    renderLastEventState(snapshot = null, statusText = 'Waiting for rotation events...', detailText = 'Live monitor is idle.', eventCount = 0) {
        if (!this.lastEventState) {
            return;
        }

        const effectiveSnapshot = snapshot || [0, 1].map((rollerId) => ({
            rollerId,
            available: true,
            isChanged: false,
            directionClass: 'idle',
            progress: 0,
            position: 0,
            incrementsPerRotation: 1
        }));

        const eventNumber = eventCount === 0 ? '--' : `#${eventCount}`;

        this.lastEventState.innerHTML = `
            <div class="event-item persistent ${eventCount === 0 ? 'is-empty' : ''}">
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

}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new MonitorDemoApp());
} else {
    new MonitorDemoApp();
}
