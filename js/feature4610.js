/**
 * Feature 4610 MultiRoller Implementation
 * 
 * This module implements the HID++ 2.0 Feature 4610 MultiRoller
 * for controlling multiple roller/wheel controls on supported devices.
 */

import { HIDPP20Device } from './hidpp20.js';

// Feature 4610 constants
const FEATURE_ID = 0x4610;
const FUNCTION_GET_CAPABILITIES = 0;
const FUNCTION_GET_ROLLERCAPABILITIES = 1;
const FUNCTION_GET_MODE = 2;
const FUNCTION_SET_MODE = 3;
const EVENT_ROTATIONEVENT = 0;

/**
 * Reporting modes for rollers
 */
export const ReportingMode = {
    Native: 0,
    Diverted: 1
};

/**
 * Feature 4610 MultiRoller class
 */
export class Feature4610MultiRoller {
    constructor(hidppDevice) {
        this.hidppDevice = hidppDevice;
        this.featureIndex = null;
        this.rotationEventHandlers = [];
    }

    /**
     * Initialize the feature by getting its index
     */
    async initialize() {
        this.featureIndex = await this.hidppDevice.getFeatureIndex(FEATURE_ID);
        
        // Register for rotation events
        this.hidppDevice.onEvent(this.featureIndex, EVENT_ROTATIONEVENT, 
            this.handleRotationEvent.bind(this));
        
        return this.featureIndex;
    }

    /**
     * Get the number of rollers on the device
     * @returns {Promise<number>} Number of rollers
     */
    async getCapabilities() {
        const response = await this.hidppDevice.sendCommand(
            this.featureIndex,
            FUNCTION_GET_CAPABILITIES,
            []
        );

        // Number of rollers is in the low nibble of the first byte
        return response[0] & 0x0F;
    }

    /**
     * Get capabilities for a specific roller
     * @param {number} rollerId - The roller ID (0-based)
     * @returns {Promise<Object>} Roller capabilities
     */
    async getRollerCapabilities(rollerId) {
        const response = await this.hidppDevice.sendCommand(
            this.featureIndex,
            FUNCTION_GET_ROLLERCAPABILITIES,
            [rollerId & 0x0F]
        );

        return {
            rollerId: rollerId,
            incrementsPerRotation: response[0],
            incrementsPerRatchet: response[1],
            lightbarId: response[2] & 0x0F,
            timestampReport: (response[2] >> 4) & 0x01,
            isRatcheted: function() {
                return this.incrementsPerRatchet !== 0x00;
            },
            hasLightbar: function() {
                return this.lightbarId !== 0x0F;
            },
            supportsTimestamp: function() {
                return this.timestampReport !== 0;
            }
        };
    }

    /**
     * Get the current reporting mode for a roller
     * @param {number} rollerId - The roller ID (0-based)
     * @returns {Promise<number>} Reporting mode (Native or Diverted)
     */
    async getMode(rollerId) {
        const response = await this.hidppDevice.sendCommand(
            this.featureIndex,
            FUNCTION_GET_MODE,
            [rollerId & 0x0F]
        );

        const isDiverted = (response[0] & 0x01) !== 0;
        return isDiverted ? ReportingMode.Diverted : ReportingMode.Native;
    }

    /**
     * Set the reporting mode for a roller
     * @param {number} rollerId - The roller ID (0-based)
     * @param {number} mode - Reporting mode (Native or Diverted)
     */
    async setMode(rollerId, mode) {
        await this.hidppDevice.sendCommand(
            this.featureIndex,
            FUNCTION_SET_MODE,
            [rollerId & 0x0F, mode & 0x01]
        );
    }

    /**
     * Handle rotation events from the device
     */
    handleRotationEvent(params) {
        if (params.length < 2) {
            console.error('Invalid rotation event packet size:', params.length);
            return;
        }

        const rollerId = params[0] & 0x0F;
        const delta = this.signedByte(params[1]);
        
        let timestamp = 0;
        if (params.length >= 6) {
            // Timestamp is a 32-bit value in bytes 2-5 (big-endian)
            timestamp = (params[2] << 24) | (params[3] << 16) | (params[4] << 8) | params[5];
        }

        // Notify all registered handlers
        this.rotationEventHandlers.forEach(handler => {
            handler(rollerId, delta, timestamp);
        });
    }

    /**
     * Convert unsigned byte to signed byte
     */
    signedByte(byte) {
        return byte > 127 ? byte - 256 : byte;
    }

    /**
     * Register a rotation event handler
     * @param {Function} handler - Callback function(rollerId, delta, timestamp)
     */
    onRotationEvent(handler) {
        this.rotationEventHandlers.push(handler);
    }

    /**
     * Unregister a rotation event handler
     * @param {Function} handler - The handler to remove
     */
    offRotationEvent(handler) {
        const index = this.rotationEventHandlers.indexOf(handler);
        if (index !== -1) {
            this.rotationEventHandlers.splice(index, 1);
        }
    }

    /**
     * Get reporting mode as string
     */
    static getModeString(mode) {
        return mode === ReportingMode.Diverted ? 'Diverted' : 'Native';
    }
}
