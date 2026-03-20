/**
 * Feature 1B04 SpecialKeys implementation.
 */

const FEATURE_ID = 0x1b04;

const FUNCTION_GET_COUNT = 0;
const FUNCTION_GET_INFO = 1;
const FUNCTION_GET_REPORTING = 2;
const FUNCTION_SET_REPORTING = 3;

const EVENT_DIVERTED_BUTTONS = 0;

export class Feature1B04SpecialKeys {
    constructor(hidppDevice) {
        this.hidppDevice = hidppDevice;
        this.featureIndex = null;
        this.keyChangeHandlers = [];
        this.boundDivertedButtonsHandler = this.handleDivertedButtonsEvent.bind(this);
    }

    async initialize() {
        this.featureIndex = await this.hidppDevice.getFeatureIndex(FEATURE_ID);
        this.hidppDevice.onEvent(this.featureIndex, EVENT_DIVERTED_BUTTONS, this.boundDivertedButtonsHandler);
        return this.featureIndex;
    }

    async getCount() {
        const response = await this.hidppDevice.sendCommand(this.featureIndex, FUNCTION_GET_COUNT, []);
        return response[0] || 0;
    }

    async getCtrlIdInfo(ctrlIdIndex) {
        const response = await this.hidppDevice.sendCommand(
            this.featureIndex,
            FUNCTION_GET_INFO,
            [ctrlIdIndex & 0xff]
        );

        return {
            ctrlId: ((response[0] || 0) << 8) | (response[1] || 0),
            taskId: ((response[2] || 0) << 8) | (response[3] || 0),
            flags: response[4] || 0,
            fpos: response[5] || 0,
            group: response[6] || 0,
            gmask: response[7] || 0,
            additionalFlags: response[8] || 0
        };
    }

    async getCtrlIdReporting(ctrlId) {
        const response = await this.hidppDevice.sendCommand(
            this.featureIndex,
            FUNCTION_GET_REPORTING,
            [(ctrlId >> 8) & 0xff, ctrlId & 0xff]
        );

        return {
            reporting: response[2] || 0,
            remap: ((response[3] || 0) << 8) | (response[4] || 0),
            reporting2: response[5] || 0
        };
    }

    async setCtrlIdReporting(ctrlId, reporting, remap = 0, reporting2 = 0) {
        await this.hidppDevice.sendCommand(
            this.featureIndex,
            FUNCTION_SET_REPORTING,
            [
                (ctrlId >> 8) & 0xff,
                ctrlId & 0xff,
                reporting & 0xff,
                (remap >> 8) & 0xff,
                remap & 0xff,
                reporting2 & 0xff
            ]
        );
    }

    async configureDiversionReporting() {
        const snapshots = [];
        const controlCount = await this.getCount();

        for (let i = 0; i < controlCount; i++) {
            let info;
            try {
                info = await this.getCtrlIdInfo(i);
            } catch (error) {
                console.warn(`Feature 1B04: failed GetCtrlIdInfo for index ${i}:`, error);
                continue;
            }

            let reportingState;
            try {
                reportingState = await this.getCtrlIdReporting(info.ctrlId);
            } catch (error) {
                console.warn(
                    `Feature 1B04: failed GetCtrlIdReporting for ctrl 0x${info.ctrlId.toString(16).padStart(4, '0')}:`,
                    error
                );
                continue;
            }

            snapshots.push({
                ctrlId: info.ctrlId,
                reporting: reportingState.reporting,
                remap: reportingState.remap,
                reporting2: reportingState.reporting2
            });

            const newReporting = reportingState.reporting | 0x03;
            try {
                await this.setCtrlIdReporting(info.ctrlId, newReporting, reportingState.remap, reportingState.reporting2);
            } catch (error) {
                console.warn(
                    `Feature 1B04: failed SetCtrlIdReporting for ctrl 0x${info.ctrlId.toString(16).padStart(4, '0')}:`,
                    error
                );
            }
        }

        return snapshots;
    }

    async restoreReporting(snapshots) {
        if (!snapshots || snapshots.length === 0) {
            return;
        }

        for (const snapshot of snapshots) {
            try {
                await this.setCtrlIdReporting(
                    snapshot.ctrlId,
                    snapshot.reporting,
                    snapshot.remap,
                    snapshot.reporting2
                );
            } catch (error) {
                console.warn(
                    `Feature 1B04: failed restoring ctrl 0x${snapshot.ctrlId.toString(16).padStart(4, '0')}:`,
                    error
                );
            }
        }
    }

    onKeyChange(handler) {
        this.keyChangeHandlers.push(handler);
    }

    offKeyChange(handler) {
        const index = this.keyChangeHandlers.indexOf(handler);
        if (index !== -1) {
            this.keyChangeHandlers.splice(index, 1);
        }
    }

    handleDivertedButtonsEvent(params) {
        if (params.length < 8) {
            return;
        }

        const controlIds = [];
        for (let i = 0; i < 8; i += 2) {
            controlIds.push(((params[i] || 0) << 8) | (params[i + 1] || 0));
        }

        this.keyChangeHandlers.forEach(handler => handler(controlIds));
    }
}
