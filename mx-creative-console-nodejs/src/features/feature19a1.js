const FEATURE_INDEX = 0x02;
const DEVICE_INDEX = 0xff;
const REPORT_ID = 0x14;
const MAX_PACKET_SIZE = 4095;

const FUNCTION_SET_IMAGE = 2;
const SOFTWARE_ID = 0x0b;

const IMAGE_FORMAT_JPEG = 0;
const IMAGE_FORMAT_RGB565 = 1;
const IMAGE_FORMAT_RGB888 = 2;

const LCD_SIZE = 118;
const BUTTON_GAP = 40;
const DISPLAY_COLS = 3;
const DISPLAY_ROWS = 3;
const ORIGIN_X = 23;
const ORIGIN_Y = 6;

const DISPLAY_W = ORIGIN_X + (DISPLAY_COLS - 1) * (LCD_SIZE + BUTTON_GAP) + LCD_SIZE;
const DISPLAY_H = ORIGIN_Y + (DISPLAY_ROWS - 1) * (LCD_SIZE + BUTTON_GAP) + LCD_SIZE;
const MAX_IMAGE_SIZE = 300 * 1024;

function buildStaticDisplayInfo() {
    const buttons = [];
    for (let i = 0; i < DISPLAY_ROWS * DISPLAY_COLS; i += 1) {
        const row = Math.floor(i / DISPLAY_COLS);
        const col = i % DISPLAY_COLS;
        buttons.push({
            shape: 1,
            location: {
                x: ORIGIN_X + col * (LCD_SIZE + BUTTON_GAP),
                y: ORIGIN_Y + row * (LCD_SIZE + BUTTON_GAP),
                w: LCD_SIZE,
                h: LCD_SIZE
            }
        });
    }

    return {
        displayShape: 0,
        dimension: 0,
        resHorizontal: DISPLAY_W,
        resVertical: DISPLAY_H,
        buttons,
        visibleAreas: []
    };
}

const STATIC_CAPS = {
    deviceScreenCount: 1,
    maxImageSize: MAX_IMAGE_SIZE,
    maxImageFPS: 10,
    deferrableDisplayUpdate: true,
    rgb565: false,
    rgb888: true,
    jpeg: true,
    calibrated: false,
    origin: 0
};

export class Feature19A1ContextualDisplay {
    constructor(hidppDevice, displayTransport = null) {
        this.hidppDevice = hidppDevice;
        this.displayTransport = displayTransport;
    }

    async initialize() {
        return FEATURE_INDEX;
    }

    close() {
        // No cleanup required for this pragmatic implementation.
    }

    async getCapabilities() {
        return STATIC_CAPS;
    }

    async getDisplayInfo(_displayIndex) {
        return buildStaticDisplayInfo();
    }

    async setImage(displayIndex, deferDisplayUpdate, images) {
        const outputTransport = this.displayTransport || this.hidppDevice.transport;

        for (const image of images) {
            const packets = this.buildPackets(displayIndex, deferDisplayUpdate, image);
            for (const packet of packets) {
                outputTransport.sendFullPacket(packet);
            }
        }

        return { resultCode: 0, count: images.length };
    }

    buildPackets(displayIndex, deferDisplayUpdate, image) {
        const { imageFormat, location, imageData } = image;
        const { x, y, w, h } = location;

        const functionSoftware = ((FUNCTION_SET_IMAGE & 0x0f) << 4) | (SOFTWARE_ID & 0x0f);
        const firstHeader = 20;
        const continuationHeader = 5;

        const packets = [];
        let part = 1;
        let offset = 0;

        const firstChunkSize = Math.min(imageData.length, MAX_PACKET_SIZE - firstHeader);
        const firstIsLast = firstChunkSize >= imageData.length;

        {
            const packet = new Uint8Array(MAX_PACKET_SIZE);
            const view = new DataView(packet.buffer);

            view.setUint8(0, REPORT_ID);
            view.setUint8(1, DEVICE_INDEX);
            view.setUint8(2, FEATURE_INDEX);
            view.setUint8(3, functionSoftware);
            view.setUint8(4, this.vlpStatus(part, true, firstIsLast));

            view.setUint8(5, displayIndex & 0xff);
            view.setUint8(6, deferDisplayUpdate ? 0x01 : 0x00);
            view.setUint8(7, 0x01);
            view.setUint8(8, imageFormat & 0x0f);
            view.setUint16(9, x);
            view.setUint16(11, y);
            view.setUint16(13, w);
            view.setUint16(15, h);
            view.setUint8(17, (imageData.length >> 16) & 0xff);
            view.setUint16(18, imageData.length & 0xffff);

            packet.set(imageData.subarray(0, firstChunkSize), firstHeader);
            packets.push(packet);

            offset = firstChunkSize;
            part += 1;
        }

        while (offset < imageData.length) {
            const chunkSize = Math.min(imageData.length - offset, MAX_PACKET_SIZE - continuationHeader);
            const isLast = offset + chunkSize >= imageData.length;

            const packet = new Uint8Array(MAX_PACKET_SIZE);
            const view = new DataView(packet.buffer);

            view.setUint8(0, REPORT_ID);
            view.setUint8(1, DEVICE_INDEX);
            view.setUint8(2, FEATURE_INDEX);
            view.setUint8(3, functionSoftware);
            view.setUint8(4, this.vlpStatus(part, false, isLast));

            packet.set(imageData.subarray(offset, offset + chunkSize), continuationHeader);
            packets.push(packet);

            offset += chunkSize;
            part += 1;
        }

        return packets;
    }

    vlpStatus(index, isFirst, isLast) {
        let value = (index & 0x0f) | 0x20;
        if (isFirst) {
            value |= 0x80;
        }

        if (isLast) {
            value |= 0x40;
        }

        return value;
    }

    static get ImageFormat() {
        return {
            JPEG: IMAGE_FORMAT_JPEG,
            RGB565: IMAGE_FORMAT_RGB565,
            RGB888: IMAGE_FORMAT_RGB888
        };
    }
}
