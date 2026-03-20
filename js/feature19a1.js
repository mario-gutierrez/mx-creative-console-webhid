/**
 * Feature 19A1 ContextualDisplay — pragmatic implementation for MX Creative Keypad.
 *
 * Feature index is hardcoded (0x02),
 * display parameters are derived from the same reverse-engineered constants, and
 * images are transmitted via report 0x14 in large sequential packets without waiting
 * for HID++ protocol ACKs between frames.
 *
 */

// Feature 0x19A1 sits at VLP feature index 2 on the MX Creative Keypad.
// This is confirmed by the key-event reports arriving on report 0x13 with byte[1]=0x02.
const FEATURE_INDEX = 0x02;
const DEVICE_INDEX = 0xff;
// Report 0x14 carries up to 4094 bytes of data per USB transfer on this device.
const REPORT_ID = 0x14;
const MAX_PACKET_SIZE = 4095; // total frame bytes including the 1-byte report-ID prefix

const FUNCTION_SET_IMAGE = 2;
const SOFTWARE_ID = 0x0b;

const IMAGE_FORMAT_JPEG = 0;
const IMAGE_FORMAT_RGB565 = 1;
const IMAGE_FORMAT_RGB888 = 2;

// ---------------------------------------------------------------------------
// MX Creative Keypad display layout constants.
// ---------------------------------------------------------------------------
const LCD_SIZE = 118;      // each square button LCD is 118 × 118 px
const BUTTON_GAP = 40;     // gap between adjacent buttons
const DISPLAY_COLS = 3;
const DISPLAY_ROWS = 3;
const ORIGIN_X = 23;       // x offset of the top-left button
const ORIGIN_Y = 6;        // y offset of the top-left button

// The display resolution is the bounding box that covers all nine button LCDs.
const DISPLAY_W = ORIGIN_X + (DISPLAY_COLS - 1) * (LCD_SIZE + BUTTON_GAP) + LCD_SIZE; // 457
const DISPLAY_H = ORIGIN_Y + (DISPLAY_ROWS - 1) * (LCD_SIZE + BUTTON_GAP) + LCD_SIZE; // 440

// A generous upper bound so JPEG quality reduction stops well before the device
// buffer limit.  In practice a 118×118 JPEG is ≤ 15 KB and a full 457×440 JPEG
// at any quality the canvas API emits is < 200 KB.
const MAX_IMAGE_SIZE = 300 * 1024;

function buildStaticDisplayInfo() {
    const buttons = [];
    for (let i = 0; i < DISPLAY_ROWS * DISPLAY_COLS; i++) {
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
    constructor(hidppDevice) {
        this.device = hidppDevice.device;
        this.featureIndex = FEATURE_INDEX;
    }

    /**
     * Verify the device exposes the output report needed for image upload.
     * Feature index is hardcoded — no HID++ or VLP discovery is attempted.
     */
    async initialize() {
        const outputReportIds = [];
        for (const collection of this.device.collections || []) {
            for (const outputReport of collection.outputReports || []) {
                outputReportIds.push(outputReport.reportId);
            }
        }

        if (!outputReportIds.includes(REPORT_ID)) {
            throw new Error(
                `Device does not expose output report 0x${REPORT_ID.toString(16).padStart(2, '0')} ` +
                'required for contextual display image upload.'
            );
        }

        console.log('[feature19a1] initialized — featureIndex hardcoded to', FEATURE_INDEX,
            '— output reportIds:', outputReportIds.map((id) => `0x${id.toString(16)}`));
        return this.featureIndex;
    }

    close() {
        // No listeners or resources to release in the pragmatic implementation.
    }

    async getCapabilities() {
        // Return the hardcoded capabilities for the MX Creative Keypad.
        return STATIC_CAPS;
    }

    async getDisplayInfo(_displayIndex) {
        // Return hardcoded layout
        return buildStaticDisplayInfo();
    }

    /**
     * Upload one or more images to the contextual display.
     *
     * Each image is serialised into one or more report-0x14 frames according to the layout described in _buildPackets().
     * Frames are sent sequentially with no ACK waiting between them.
     */
    async setImage(displayIndex, deferDisplayUpdate, images) {
        for (const image of images) {
            const packets = this._buildPackets(displayIndex, deferDisplayUpdate, image);
            for (const packet of packets) {
                // packet[0] is the report ID; sendReport takes (reportId, data).
                await this.device.sendReport(packet[0], packet.slice(1));
            }
        }
        return { resultCode: 0, count: images.length };
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Build the sequence of 4095-byte frames for a single setImage descriptor.
     *
     * Frame layout:
     *   Byte 0   : report ID (0x14)
     *   Byte 1   : device index (0xff)
     *   Byte 2   : feature index (0x02)
     *   Byte 3   : (FUNCTION_SET_IMAGE << 4) | SOFTWARE_ID  = 0x2b
     *   Byte 4   : VLP status byte  (first|last|seq bits)
     *   --- first frame only: 15-byte setImage command header at bytes 5–19 ---
     *   Byte 5   : displayIndex
     *   Byte 6   : deferDisplayUpdate
     *   Byte 7   : numImages (always 1 — one descriptor per call)
     *   Byte 8   : imageFormat
     *   Bytes 9–10  : x  (uint16 BE)
     *   Bytes 11–12 : y  (uint16 BE)
     *   Bytes 13–14 : w  (uint16 BE)
     *   Bytes 15–16 : h  (uint16 BE)
     *   Byte 17  : imageData.length >> 16
     *   Bytes 18–19 : imageData.length & 0xffff (uint16 BE)
     *   Bytes 20+   : image data (first frame)
     *   --- continuation frames: image data starts at byte 5 ---
     */
    _buildPackets(displayIndex, deferDisplayUpdate, image) {
        const { imageFormat, location, imageData } = image;
        const { x, y, w, h } = location;

        const FN_SW = ((FUNCTION_SET_IMAGE & 0x0f) << 4) | (SOFTWARE_ID & 0x0f); // 0x2b

        const FIRST_HEADER = 20;  // HID header(4) + VLP status(1) + setImage cmd header(15)
        const CONT_HEADER = 5;    // HID header(4) + VLP status(1)

        const packets = [];
        let part = 1;
        let offset = 0;

        // --- First frame ---
        {
            const chunkSize = Math.min(imageData.length, MAX_PACKET_SIZE - FIRST_HEADER);
            const isLast = chunkSize >= imageData.length;

            const packet = new Uint8Array(MAX_PACKET_SIZE);
            const view = new DataView(packet.buffer);

            view.setUint8(0, REPORT_ID);
            view.setUint8(1, DEVICE_INDEX);
            view.setUint8(2, FEATURE_INDEX);
            view.setUint8(3, FN_SW);
            view.setUint8(4, this._vlpStatus(part, true, isLast));

            // setImage command header
            view.setUint8(5, displayIndex & 0xff);
            view.setUint8(6, deferDisplayUpdate ? 0x01 : 0x00);
            view.setUint8(7, 0x01);                              // numImages = 1
            view.setUint8(8, imageFormat & 0x0f);
            view.setUint16(9, x);                                // big-endian
            view.setUint16(11, y);
            view.setUint16(13, w);
            view.setUint16(15, h);
            view.setUint8(17, (imageData.length >> 16) & 0xff);  // high byte of 24-bit size
            view.setUint16(18, imageData.length & 0xffff);        // low 2 bytes

            packet.set(imageData.subarray(0, chunkSize), FIRST_HEADER);
            packets.push(packet);

            offset = chunkSize;
            part++;
        }

        // --- Continuation frames ---
        while (offset < imageData.length) {
            const chunkSize = Math.min(imageData.length - offset, MAX_PACKET_SIZE - CONT_HEADER);
            const isLast = (offset + chunkSize) >= imageData.length;

            const packet = new Uint8Array(MAX_PACKET_SIZE);
            const view = new DataView(packet.buffer);

            view.setUint8(0, REPORT_ID);
            view.setUint8(1, DEVICE_INDEX);
            view.setUint8(2, FEATURE_INDEX);
            view.setUint8(3, FN_SW);
            view.setUint8(4, this._vlpStatus(part, false, isLast));

            packet.set(imageData.subarray(offset, offset + chunkSize), CONT_HEADER);
            packets.push(packet);

            offset += chunkSize;
            part++;
        }

        return packets;
    }

    /**
     * Construct the VLP status byte.
     *   bit 7 = isFirst
     *   bit 6 = isLast
     *   bit 5 = always set (data-frame marker)
     *   bits 3:0 = frame sequence index (starts at 1)
     */
    _vlpStatus(index, isFirst, isLast) {
        let value = (index & 0x0f) | 0x20;
        if (isFirst) value |= 0x80;
        if (isLast) value |= 0x40;
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
