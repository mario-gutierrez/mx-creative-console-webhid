/**
 * HID++ 2.0 Protocol Implementation for WebHID
 * 
 * This module provides low-level communication with Logitech devices
 * using the HID++ 2.0 protocol over WebHID.
 */

export class HIDPP20Device {
    constructor(device) {
        this.device = device;
        this.featureCache = new Map();
        this.pendingRequests = new Map();
        this.requestId = 0;
        this.eventHandlers = new Map();
    }

    /**
     * Open the HID device and start listening for reports
     */
    async open() {
        await this.device.open();
        this.device.addEventListener('inputreport', this.handleInputReport.bind(this));
    }

    /**
     * Close the HID device
     */
    async close() {
        await this.device.close();
    }

    /**
     * Get the feature index for a given feature ID
     * Feature 0x0000 (Root) is always at index 0
     * Feature 0x0001 (FeatureSet) is always at index 1
     */
    async getFeatureIndex(featureId) {
        // Check cache first
        if (this.featureCache.has(featureId)) {
            return this.featureCache.get(featureId);
        }

        // Root feature is always at index 0
        if (featureId === 0x0000) {
            this.featureCache.set(featureId, 0);
            return 0;
        }

        // Query the root feature to get the index
        const response = await this.sendCommand(0x00, 0x00, [
            (featureId >> 8) & 0xFF,
            featureId & 0xFF,
            0x00
        ]);

        const featureIndex = response[0];
        const featureType = response[1];

        if (featureIndex === 0) {
            throw new Error(`Feature 0x${featureId.toString(16).padStart(4, '0')} not found`);
        }

        this.featureCache.set(featureId, featureIndex);
        return featureIndex;
    }

    /**
     * Send a HID++ 2.0 command and wait for response
     * @param {number} featureIndex - The feature index (0-255)
     * @param {number} functionId - The function ID (0-15)
     * @param {Array<number>} params - Command parameters (up to 16 bytes)
     * @returns {Promise<Uint8Array>} Response data
     */
    async sendCommand(featureIndex, functionId, params = []) {
        const requestId = this.requestId++;
        
        // Build HID++ 2.0 long report (20 bytes)
        const report = new Uint8Array(20);
        report[0] = 0x11; // Report ID for HID++ 2.0 long report
        report[1] = 0xFF; // Device index (0xFF = receiver/dongle, 0x00-0x05 = device)
        report[2] = featureIndex;
        report[3] = (functionId << 4) | 0x00; // Function ID in upper nibble, software ID in lower
        
        // Copy parameters
        for (let i = 0; i < Math.min(params.length, 16); i++) {
            report[4 + i] = params[i];
        }

        // Create promise for response
        const responsePromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error('Command timeout'));
            }, 5000);

            this.pendingRequests.set(requestId, { resolve, reject, timeout, featureIndex, functionId });
        });

        // Send the report
        await this.device.sendReport(0x11, report.slice(1)); // Skip report ID for sendReport

        return responsePromise;
    }

    /**
     * Handle incoming HID reports
     */
    handleInputReport(event) {
        const { data, reportId } = event;
        const bytes = new Uint8Array(data.buffer);

        // HID++ 2.0 long report
        if (reportId === 0x11 && bytes.length >= 7) {
            const deviceIndex = bytes[0];
            const featureIndex = bytes[1];
            const functionId = (bytes[2] >> 4) & 0x0F;
            const softwareId = bytes[2] & 0x0F;
            const params = bytes.slice(3);

            // Check if this is a response to a pending request
            let handled = false;
            for (const [requestId, request] of this.pendingRequests.entries()) {
                if (request.featureIndex === featureIndex) {
                    clearTimeout(request.timeout);
                    this.pendingRequests.delete(requestId);
                    request.resolve(params);
                    handled = true;
                    break;
                }
            }

            // If not handled as a response, treat as an event
            if (!handled) {
                this.handleEvent(featureIndex, functionId, params);
            }
        }
    }

    /**
     * Handle HID++ events
     */
    handleEvent(featureIndex, eventId, params) {
        const key = `${featureIndex}:${eventId}`;
        const handlers = this.eventHandlers.get(key);
        if (handlers) {
            handlers.forEach(handler => handler(params));
        }
    }

    /**
     * Register an event handler
     */
    onEvent(featureIndex, eventId, handler) {
        const key = `${featureIndex}:${eventId}`;
        if (!this.eventHandlers.has(key)) {
            this.eventHandlers.set(key, []);
        }
        this.eventHandlers.get(key).push(handler);
    }

    /**
     * Unregister an event handler
     */
    offEvent(featureIndex, eventId, handler) {
        const key = `${featureIndex}:${eventId}`;
        const handlers = this.eventHandlers.get(key);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index !== -1) {
                handlers.splice(index, 1);
            }
        }
    }
}

/**
 * Helper function to request a HID device with Logitech vendor ID
 */
export async function requestLogitechDevice() {
    const devices = await requestLogitechDevices();
    if (devices.length > 0) {
        return devices[0];
    }

    return null;
}

/**
 * Request Logitech HID devices via browser picker.
 * @returns {Promise<Array<HIDDevice>>}
 */
export async function requestLogitechDevices() {
    const filters = [
        { vendorId: 0x046d } // Logitech vendor ID
    ];

    try {
        return await navigator.hid.requestDevice({ filters });
    } catch (error) {
        console.error('Error requesting devices:', error);
        throw error;
    }
}

/**
 * Get all previously authorized Logitech devices
 */
export async function getAuthorizedDevices() {
    const devices = await navigator.hid.getDevices();
    return devices.filter(device => device.vendorId === 0x046d);
}
