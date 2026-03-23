import sharp from 'sharp';
import { Feature19A1ContextualDisplay } from './features/feature19a1.js';

export async function encodeAreaImageFromBuffer(imageBuffer, width, height, caps) {
    if (!Buffer.isBuffer(imageBuffer)) {
        throw new Error('Image must be provided as a Buffer.');
    }

    if (caps.jpeg) {
        const qualities = [95, 85, 75, 65, 55, 45, 35, 25];
        for (const quality of qualities) {
            const jpegBuffer = await sharp(imageBuffer)
                .resize(width, height, { fit: 'fill' })
                .jpeg({ quality })
                .toBuffer();

            if (jpegBuffer.length <= caps.maxImageSize) {
                return {
                    imageFormat: Feature19A1ContextualDisplay.ImageFormat.JPEG,
                    imageData: Uint8Array.from(jpegBuffer)
                };
            }
        }
    }

    if (caps.rgb888) {
        const { data, info } = await sharp(imageBuffer)
            .resize(width, height, { fit: 'fill' })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        if (info.channels !== 3) {
            throw new Error(`Expected RGB image with 3 channels, got ${info.channels}.`);
        }

        if (data.length <= caps.maxImageSize) {
            return {
                imageFormat: Feature19A1ContextualDisplay.ImageFormat.RGB888,
                imageData: Uint8Array.from(data)
            };
        }
    }

    throw new Error('Could not encode image under device max image size with supported formats.');
}
