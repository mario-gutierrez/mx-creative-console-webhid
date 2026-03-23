import { EventEmitter } from 'node:events';

export class HIDPP20Device extends EventEmitter {
    constructor(transport) {
        super();
        this.transport = transport;
        this.featureCache = new Map();
        this.pendingRequests = new Map();
        this.requestId = 0;
        this.eventHandlers = new Map();
        this.boundInputHandler = this.handleInputReport.bind(this);
        this.isClosed = false;
    }

    open() {
        this.isClosed = false;
        this.transport.open();
        this.transport.on('inputreport', this.boundInputHandler);
    }

    close() {
        this.isClosed = true;
        this.transport.off('inputreport', this.boundInputHandler);
        this.rejectAllPending(new Error('Device closed'));
        this.transport.close();
    }

    rejectAllPending(error) {
        for (const [pendingId, request] of this.pendingRequests.entries()) {
            clearTimeout(request.timeout);
            this.pendingRequests.delete(pendingId);
            request.reject(error);
        }
    }

    async getFeatureIndex(featureId) {
        if (this.featureCache.has(featureId)) {
            return this.featureCache.get(featureId);
        }

        if (featureId === 0x0000) {
            this.featureCache.set(featureId, 0);
            return 0;
        }

        const response = await this.sendCommand(0x00, 0x00, [
            (featureId >> 8) & 0xff,
            featureId & 0xff,
            0x00
        ]);

        const featureIndex = response[0] || 0;
        if (featureIndex === 0) {
            throw new Error(`Feature 0x${featureId.toString(16).padStart(4, '0')} not found`);
        }

        this.featureCache.set(featureId, featureIndex);
        return featureIndex;
    }

    sendCommand(featureIndex, functionId, params = []) {
        if (this.isClosed) {
            return Promise.reject(new Error('Device is closed'));
        }

        const requestId = this.requestId++;

        const report = new Uint8Array(20);
        report[0] = 0x11;
        report[1] = 0xff;
        report[2] = featureIndex;
        report[3] = (functionId << 4) | 0x00;

        for (let i = 0; i < Math.min(params.length, 16); i += 1) {
            report[4 + i] = params[i];
        }

        const responsePromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error('Command timeout'));
            }, 5000);

            this.pendingRequests.set(requestId, {
                resolve,
                reject,
                timeout,
                featureIndex,
                functionId
            });
        });

        // Attach a noop catch so transient transport failures do not become
        // unhandled rejections if callers lose their await path during teardown.
        responsePromise.catch(() => { });

        try {
            this.transport.sendReport(0x11, report.slice(1));
        } catch (error) {
            const pending = this.pendingRequests.get(requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(requestId);
                pending.reject(error);
            }
        }

        return responsePromise;
    }

    handleInputReport(event) {
        const { reportId, data } = event;
        const bytes = Uint8Array.from(data);

        if (reportId !== 0x11 || bytes.length < 7) {
            return;
        }

        const featureIndex = bytes[1];
        const functionId = (bytes[2] >> 4) & 0x0f;
        const params = bytes.slice(3);

        let handled = false;
        for (const [pendingId, request] of this.pendingRequests.entries()) {
            if (request.featureIndex === featureIndex && request.functionId === functionId) {
                clearTimeout(request.timeout);
                this.pendingRequests.delete(pendingId);
                request.resolve(params);
                handled = true;
                break;
            }
        }

        if (!handled) {
            this.handleEvent(featureIndex, functionId, params);
        }
    }

    handleEvent(featureIndex, eventId, params) {
        const key = `${featureIndex}:${eventId}`;
        const handlers = this.eventHandlers.get(key);
        if (!handlers) {
            return;
        }

        for (const handler of handlers) {
            handler(params);
        }
    }

    onEvent(featureIndex, eventId, handler) {
        const key = `${featureIndex}:${eventId}`;
        if (!this.eventHandlers.has(key)) {
            this.eventHandlers.set(key, []);
        }

        this.eventHandlers.get(key).push(handler);
    }

    offEvent(featureIndex, eventId, handler) {
        const key = `${featureIndex}:${eventId}`;
        const handlers = this.eventHandlers.get(key);
        if (!handlers) {
            return;
        }

        const index = handlers.indexOf(handler);
        if (index !== -1) {
            handlers.splice(index, 1);
        }
    }
}
