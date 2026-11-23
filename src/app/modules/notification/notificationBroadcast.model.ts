import { model, Schema, Types } from 'mongoose';
import { NOTIFICATION_ENTITY } from './notification.interface';

export const BROADCAST_AUDIENCES = ['all', 'listeners', 'creators'] as const;
export type BroadcastAudience = (typeof BROADCAST_AUDIENCES)[number];
export const BROADCAST_STATUS = ['pending', 'running', 'done', 'failed'] as const;

/**
 * An admin announcement, delivered in the background: the worker walks the audience in batches,
 * writes one inbox row per user and sends push to their devices. Resumable via `cursor`.
 */
export interface INotificationBroadcast {
    title: string;
    message: string;
    data?: { entity: string; entityId?: string | null };
    audience: BroadcastAudience;
    status: (typeof BROADCAST_STATUS)[number];
    /** Which collection is being walked and the last _id done in it. */
    phase: 'NormalUser' | 'Creator';
    cursor?: Types.ObjectId | null;
    recipients: number;
    pushed: number;
    lockedUntil?: Date | null;
    lastError?: string | null;
    createdBy?: string;
    finishedAt?: Date | null;
}

const broadcastSchema = new Schema<INotificationBroadcast>(
    {
        title: { type: String, required: true, trim: true, maxlength: 200 },
        message: { type: String, required: true, trim: true, maxlength: 1000 },
        data: {
            entity: {
                type: String,
                enum: Object.values(NOTIFICATION_ENTITY),
                default: NOTIFICATION_ENTITY.NONE,
            },
            entityId: { type: String, default: null },
        },
        audience: { type: String, enum: BROADCAST_AUDIENCES, default: 'all' },
        status: { type: String, enum: BROADCAST_STATUS, default: 'pending' },
        phase: { type: String, enum: ['NormalUser', 'Creator'], required: true },
        cursor: { type: Schema.Types.ObjectId, default: null },
        recipients: { type: Number, default: 0 },
        pushed: { type: Number, default: 0 },
        lockedUntil: { type: Date, default: null },
        lastError: { type: String, default: null },
        createdBy: { type: String },
        finishedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

broadcastSchema.index({ status: 1, createdAt: 1 });

export const NotificationBroadcast = model<INotificationBroadcast>(
    'NotificationBroadcast',
    broadcastSchema
);
