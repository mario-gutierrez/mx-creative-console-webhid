/**
 * Feature 8040 BrightnessControl implementation.
 */

const FEATURE_ID = 0x8040;

const FUNCTION_GET_INFO = 0;
const FUNCTION_GET_BRIGHTNESS = 1;
const FUNCTION_SET_BRIGHTNESS = 2;

export class Feature8040BrightnessControl {
    constructor(hidppDevice) {
        this.hidppDevice = hidppDevice;
        this.featureIndex = null;
    }

    async initialize() {
        this.featureIndex = await this.hidppDevice.getFeatureIndex(FEATURE_ID);
        return this.featureIndex;
    }

    async getInfo() {
        const response = await this.hidppDevice.sendCommand(this.featureIndex, FUNCTION_GET_INFO, []);

        if (response.length < 7) {
            throw new Error('Feature 0x8040 getInfo response too short');
        }

        return {
            maxBrightness: ((response[0] || 0) << 8) | (response[1] || 0),
            steps: ((response[6] || 0) << 8) | (response[2] || 0),
            capabilities: response[3] || 0,
            minBrightness: ((response[4] || 0) << 8) | (response[5] || 0)
        };
    }

    async getBrightness() {
        const response = await this.hidppDevice.sendCommand(this.featureIndex, FUNCTION_GET_BRIGHTNESS, []);

        if (response.length < 2) {
            throw new Error('Feature 0x8040 getBrightness response too short');
        }

        return ((response[0] || 0) << 8) | (response[1] || 0);
    }

    async setBrightness(brightness) {
        const raw = Math.max(0, Math.min(0xffff, Number(brightness) || 0));

        await this.hidppDevice.sendCommand(this.featureIndex, FUNCTION_SET_BRIGHTNESS, [
            (raw >> 8) & 0xff,
            raw & 0xff
        ]);
    }
}
