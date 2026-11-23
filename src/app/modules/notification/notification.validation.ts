import { z } from 'zod';
import { NOTIFICATION_ENTITY } from './notification.interface';
import { BROADCAST_AUDIENCES } from './notificationBroadcast.model';

export const broadcastValidationSchema = z.object({
    body: z.object({
        title: z.string().trim().min(1, 'Title is required').max(200),
        message: z.string().trim().min(1, 'Message is required').max(1000),
        audience: z.enum(BROADCAST_AUDIENCES).optional(),
        // Optional deep link, e.g. { entity: 'PODCAST', entityId: '<podcast id>' }.
        data: z
            .object({
                entity: z.enum(Object.values(NOTIFICATION_ENTITY) as [string, ...string[]]),
                entityId: z.string().max(100).nullable().optional(),
            })
            .optional(),
    }),
});
