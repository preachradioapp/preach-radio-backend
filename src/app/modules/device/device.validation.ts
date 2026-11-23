import { z } from 'zod';
import { DEVICE_PLATFORMS } from './device.model';

const playerId = z.string().trim().min(8, 'Invalid device id').max(128, 'Invalid device id');

export const registerDeviceValidationSchema = z.object({
    body: z.object({ playerId, platform: z.enum(DEVICE_PLATFORMS) }),
});

export const unregisterDeviceValidationSchema = z.object({
    body: z.object({ playerId }),
});
