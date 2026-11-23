import { Types } from 'mongoose';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';

export type NotificationType =
    (typeof ENUM_NOTIFICATION_TYPE)[keyof typeof ENUM_NOTIFICATION_TYPE];

/** What a tap opens. The app routes on `entity` + `entityId`. */
export const NOTIFICATION_ENTITY = {
    PODCAST: 'PODCAST',
    LIVE_ROOM: 'LIVE_ROOM',
    FEEDBACK: 'FEEDBACK',
    CREATOR: 'CREATOR',
    REPORT: 'REPORT',
    NONE: 'NONE',
} as const;
export type NotificationEntity =
    (typeof NOTIFICATION_ENTITY)[keyof typeof NOTIFICATION_ENTITY];

export interface INotificationData {
    entity: NotificationEntity;
    /** Usually an ObjectId; a string for external ids (e.g. a 100ms room id). */
    entityId?: string | null;
    /** Small extra context for the client (e.g. { commentId }). */
    meta?: Record<string, unknown>;
}

export const PUSH_STATUS = ['none', 'pending', 'sent', 'skipped', 'failed'] as const;
export type PushStatus = (typeof PUSH_STATUS)[number];

export interface IPushState {
    /** none: in-app only · pending: waiting for the worker · sent / skipped (no device) / failed (gave up). */
    status: PushStatus;
    attempts: number;
    nextAttemptAt?: Date | null;
    /** Worker lease (several server instances can run the worker safely). */
    lockedUntil?: Date | null;
    sentAt?: Date | null;
    lastError?: string | null;
}

export interface INotification {
    /** Profile id of the recipient, or 'superAdmin' for the dashboard. */
    receiver: string;
    type: NotificationType;
    title: string;
    message: string;
    data?: INotificationData;
    isRead: boolean;
    readAt?: Date | null;
    push: IPushState;
    /** TTL: the row is removed after this date. */
    expiresAt?: Date | null;

    /** @deprecated legacy rows: deep link (now `data.entityId`). */
    redirectId?: string | null;
    /** @deprecated legacy broadcast rows (receiver 'all'): who has seen / hidden it. */
    seenBy?: Types.ObjectId[];
    deleteBy?: Types.ObjectId[];

    createdAt?: Date;
    updatedAt?: Date;
}
