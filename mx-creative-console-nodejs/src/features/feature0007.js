const FEATURE_ID = 0x0007;
const FUNCTION_GET_FRIENDLY_NAME_LEN = 0;
const FUNCTION_GET_FRIENDLY_NAME = 1;

export class Feature0007DeviceFriendlyName {
    constructor(hidppDevice) {
        this.hidppDevice = hidppDevice;
        this.featureIndex = null;
        this.decoder = new TextDecoder('utf-8', { fatal: false });
    }

    async initialize() {
        this.featureIndex = await this.hidppDevice.getFeatureIndex(FEATURE_ID);
        return this.featureIndex;
    }

    async getFriendlyNameLen() {
        const response = await this.hidppDevice.sendCommand(this.featureIndex, FUNCTION_GET_FRIENDLY_NAME_LEN, []);
        return {
            nameLen: response[0] || 0,
            nameMaxLen: response[1] || 0,
            defaultNameLen: response[2] || 0
        };
    }

    async getFriendlyNameChunk(charIndex) {
        const response = await this.hidppDevice.sendCommand(this.featureIndex, FUNCTION_GET_FRIENDLY_NAME, [charIndex & 0xff]);

        if (response.length < 16) {
            throw new Error('Feature 0x0007 response too short');
        }

        if (response[0] !== (charIndex & 0xff)) {
            throw new Error('Feature 0x0007 charIndex mismatch');
        }

        return response.slice(1, 16);
    }

    async getFriendlyName() {
        const { nameLen } = await this.getFriendlyNameLen();
        if (nameLen === 0) {
            return '';
        }

        const bytes = [];
        let charIndex = 0;

        while (charIndex < nameLen) {
            const chunk = await this.getFriendlyNameChunk(charIndex);

            for (const b of chunk) {
                if (b === 0x00) {
                    charIndex = nameLen;
                    break;
                }

                bytes.push(b);
                if (bytes.length >= nameLen) {
                    charIndex = nameLen;
                    break;
                }
            }

            charIndex += chunk.length;
        }

        return this.decoder.decode(new Uint8Array(bytes)).trim();
    }
}
