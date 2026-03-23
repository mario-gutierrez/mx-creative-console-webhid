export const LOGITECH_VENDOR_ID = 0x046d;

export const PRODUCT_ID_KEYPAD = 0xc354;
export const PRODUCT_ID_DIALPAD = 0xbc00;

export const FEATURE_ID_MULTIROLLER = 0x4610;
export const FEATURE_ID_SPECIAL_KEYS = 0x1b04;
export const FEATURE_ID_BRIGHTNESS = 0x8040;
export const FEATURE_ID_CONTEXTUAL_DISPLAY = 0x19a1;

export const RAW_VLP_REPORT_ID = 0x13;

export const KEYPAD_KEYS = [
    { controlId: 0x0001, label: '1' },
    { controlId: 0x0002, label: '2' },
    { controlId: 0x0003, label: '3' },
    { controlId: 0x0004, label: '4' },
    { controlId: 0x0005, label: '5' },
    { controlId: 0x0006, label: '6' },
    { controlId: 0x0007, label: '7' },
    { controlId: 0x0008, label: '8' },
    { controlId: 0x0009, label: '9' },
    { controlId: 0x01a1, label: 'PREV' },
    { controlId: 0x01a2, label: 'NEXT' }
];

export const DIALPAD_KEYS = [
    { controlId: 0x0053, label: 'D1' },
    { controlId: 0x0056, label: 'D2' },
    { controlId: 0x0059, label: 'D3' },
    { controlId: 0x005a, label: 'D4' }
];

export function roleFromProductId(productId) {
    if ((productId || 0) === PRODUCT_ID_KEYPAD) {
        return 'keypad';
    }

    if ((productId || 0) === PRODUCT_ID_DIALPAD) {
        return 'dialpad';
    }

    return null;
}

export function formatHex4(value) {
    return `0x${(value || 0).toString(16).padStart(4, '0').toUpperCase()}`;
}

export function brightnessToPercent(rawBrightness, minBrightness, maxBrightness) {
    if (maxBrightness <= minBrightness) {
        return Math.min(100, Math.max(0, rawBrightness));
    }

    const range = maxBrightness - minBrightness;
    const normalized = rawBrightness > minBrightness ? rawBrightness - minBrightness : 0;
    const percent = Math.round((normalized * 100) / range);
    return Math.min(100, Math.max(0, percent));
}

export function percentToBrightness(percent, minBrightness, maxBrightness) {
    let safePercent = Number(percent);
    if (!Number.isFinite(safePercent)) {
        safePercent = 0;
    }

    safePercent = Math.round(Math.max(0, Math.min(100, safePercent)));

    if (maxBrightness <= minBrightness) {
        return safePercent;
    }

    const range = maxBrightness - minBrightness;
    return minBrightness + Math.round((safePercent * range) / 100);
}
