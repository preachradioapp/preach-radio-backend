import { model, Schema } from 'mongoose';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import {
    INotification,
    NOTIFICATION_ENTITY,
    PUSH_STATUS,
} from './notification.interface';

/** Inbox retention. */
export const NOTIFICATION_TTL_DAYS = 120;

const notificationSchema = new Schema<INotification>(
    {
        receiver: { type: String, required: true },
        type: {
            type: String,
            enum: Object.values(ENUM_NOTIFICATION_TYPE),
            required: true,
        },
        title: { type: String, required: true, trim: true, maxlength: 200 },
        message: { type: String, required: true, trim: true, maxlength: 1000 },
        data: {
            entity: {
                type: String,
                enum: Object.values(NOTIFICATION_ENTITY),
                default: NOTIFICATION_ENTITY.NONE,
            },
            entityId: { type: String, default: null },
            meta: { type: Schema.Types.Mixed, default: undefined },
        },
        isRead: { type: Boolean, default: false },
        readAt: { type: Date, default: null },
        push: {
            status: { type: String, enum: PUSH_STATUS, default: 'none' },
            attempts: { type: Number, default: 0 },
            nextAttemptAt: { type: Date, default: null },
            lockedUntil: { type: Date, default: null },
            sentAt: { type: Date, default: null },
            lastError: { type: String, default: null },
        },
        expiresAt: {
            type: Date,
            default: () => new Date(Date.now() + NOTIFICATION_TTL_DAYS * 86_400_000),
        },

        // Legacy (rows created before per-user notifications); read-only now.
        redirectId: { type: String, default: undefined },
        seenBy: { type: [Schema.Types.ObjectId], default: undefined },
        deleteBy: { type: [Schema.Types.ObjectId], default: undefined },
    },
    { timestamps: true }
);

// A user's inbox, newest first.
notificationSchema.index({ receiver: 1, createdAt: -1 });
// Unread badge.
notificationSchema.index({ receiver: 1, isRead: 1 });
// The push worker's queue: due, unlocked rows only (partial = tiny index).
notificationSchema.index(
    { 'push.nextAttemptAt': 1 },
    { partialFilterExpression: { 'push.status': 'pending' } }
);
// Retention (rows without expiresAt — legacy — are kept).
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Notification = model<INotification>('Notification', notificationSchema);
export default Notification;
