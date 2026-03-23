import { EventEmitter } from 'node:events';
import HID from 'node-hid';

function normalizeIncomingPacket(dataBuffer) {
    const data = Uint8Array.from(dataBuffer);
    if (data.length === 0) {
        return null;
    }

    if (data[0] === 0x11 || data[0] === 0x13 || data[0] === 0x14) {
        return {
            reportId: data[0],
            payload: data.slice(1)
        };
    }

    // On some platforms node-hid strips report IDs from input packets.
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0x02 && data[2] === 0x00) {
        return {
            reportId: 0x13,
            payload: data
        };
    }

    return {
        reportId: 0x11,
        payload: data
    };
}

export function listCreativeConsoleHidDevices(vendorId, productIds) {
    const allowed = new Set(productIds.map((value) => value || 0));
    return HID.devices().filter((device) => {
        if ((device.vendorId || 0) !== vendorId) {
            return false;
        }

        return allowed.has(device.productId || 0);
    });
}

export class HIDNodeTransport extends EventEmitter {
    constructor(deviceInfo) {
        super();
        this.deviceInfo = deviceInfo;
        this.hidDevice = null;
    }

    open() {
        if (this.hidDevice) {
            return;
        }

        this.hidDevice = new HID.HID(this.deviceInfo.path);
        this.hidDevice.on('data', (buffer) => {
            const packet = normalizeIncomingPacket(buffer);
            if (!packet) {
                return;
            }

            this.emit('inputreport', {
                reportId: packet.reportId,
                data: packet.payload
            });
        });

        this.hidDevice.on('error', (error) => {
            this.emit('transportError', error);
        });
    }

    close() {
        if (!this.hidDevice) {
            return;
        }

        const hid = this.hidDevice;
        this.hidDevice = null;

        try {
            hid.close();
        } catch (_error) {
            // Ignore close errors to keep shutdown resilient.
        }
    }

    sendReport(reportId, payload) {
        if (!this.hidDevice) {
            throw new Error('Transport is not open.');
        }

        const frame = [reportId, ...Array.from(payload)];
        this.hidDevice.write(frame);
    }

    sendFullPacket(packetWithReportId) {
        if (!this.hidDevice) {
            throw new Error('Transport is not open.');
        }

        this.hidDevice.write(Array.from(packetWithReportId));
    }
}
