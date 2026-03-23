const FEATURE_ID = 0x4610;
const FUNCTION_GET_CAPABILITIES = 0;
const FUNCTION_GET_ROLLERCAPABILITIES = 1;
const FUNCTION_GET_MODE = 2;
const FUNCTION_SET_MODE = 3;
const EVENT_ROTATIONEVENT = 0;

export const ReportingMode = {
    Native: 0,
    Diverted: 1
};

export class Feature4610MultiRoller {
    constructor(hidppDevice) {
        this.hidppDevice = hidppDevice;
        this.featureIndex = null;
        this.rotationEventHandlers = [];
        this.boundRotationHandler = this.handleRotationEvent.bind(this);
    }

    async initialize() {
        this.featureIndex = await this.hidppDevice.getFeatureIndex(FEATURE_ID);
        this.hidppDevice.onEvent(this.featureIndex, EVENT_ROTATIONEVENT, this.boundRotationHandler);
        return this.featureIndex;
    }

    async getCapabilities() {
        const response = await this.hidppDevice.sendCommand(this.featureIndex, FUNCTION_GET_CAPABILITIES, []);
        return response[0] & 0x0f;
    }

    async getRollerCapabilities(rollerId) {
        const response = await this.hidppDevice.sendCommand(this.featureIndex, FUNCTION_GET_ROLLERCAPABILITIES, [rollerId & 0x0f]);

        return {
            rollerId,
            incrementsPerRotation: response[0],
            incrementsPerRatchet: response[1],
            lightbarId: response[2] & 0x0f,
            timestampReport: (response[2] >> 4) & 0x01
        };
    }

    async setMode(rollerId, mode) {
        await this.hidppDevice.sendCommand(this.featureIndex, FUNCTION_SET_MODE, [rollerId & 0x0f, mode & 0x01]);
    }

    onRotationEvent(handler) {
        this.rotationEventHandlers.push(handler);
    }

    offRotationEvent(handler) {
        const index = this.rotationEventHandlers.indexOf(handler);
        if (index !== -1) {
            this.rotationEventHandlers.splice(index, 1);
        }
    }

    handleRotationEvent(params) {
        if (params.length < 2) {
            return;
        }

        const rollerId = params[0] & 0x0f;
        const delta = params[1] > 127 ? params[1] - 256 : params[1];

        let timestamp = 0;
        if (params.length >= 6) {
            timestamp = (params[2] << 24) | (params[3] << 16) | (params[4] << 8) | params[5];
        }

        for (const handler of this.rotationEventHandlers) {
            handler(rollerId, delta, timestamp);
        }
    }

    static getModeString(mode) {
        return mode === ReportingMode.Diverted ? 'Diverted' : 'Native';
    }
}
