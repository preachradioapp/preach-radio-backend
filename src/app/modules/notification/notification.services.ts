/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import { JwtPayload } from 'jsonwebtoken';
import { Types } from 'mongoose';
import AppError from '../../error/appError';
import { errorLogger } from '../../shared/logger';
import { USER_ROLE } from '../user/user.constant';
import {
    INotificationData,
    NOTIFICATION_ENTITY,
    NotificationType,
} from './notification.interface';
import Notification from './notification.model';
import {
    BroadcastAudience,
    NotificationBroadcast,
} from './notificationBroadcast.model';
import { kickNotificationWorker } from './notification.worker';

/** Inbox owner key: the dashboard shares one 'superAdmin' inbox; everyone else uses their profile id. */
const inboxOf = (user: JwtPayload) =>
    user?.role === USER_ROLE.superAdmin || user?.role === USER_ROLE.admin
        ? USER_ROLE.superAdmin
        : String(user?.profileId);

const isAdminInbox = (receiver: string) => receiver === USER_ROLE.superAdmin;
const oid = (id: string) => new Types.ObjectId(id);
const LEGACY_BROADCAST = 'all';

/**
 * Rows this inbox can see: its own, plus legacy broadcast rows (receiver 'all', created before
 * per-user notifications) it hasn't hidden. New broadcasts are written per user.
 */
const visibleTo = (receiver: string) =>
    isAdminInbox(receiver)
        ? { receiver }
        : {
              $or: [
                  { receiver },
                  { receiver: LEGACY_BROADCAST, deleteBy: { $ne: oid(receiver) } },
              ],
          };

/** Unread for this inbox (legacy rows track readers in `seenBy`). */
const unreadFor = (receiver: string) =>
    isAdminInbox(receiver)
        ? { receiver, isRead: { $ne: true } }
        : {
              $or: [
                  { receiver, isRead: { $ne: true } },
                  {
                      receiver: LEGACY_BROADCAST,
                      deleteBy: { $ne: oid(receiver) },
                      seenBy: { $ne: oid(receiver) },
                  },
              ],
          };

/** The client shape. `redirectId` and `isSeen` are kept for apps built before `data` / `isRead`. */
const toView = (n: any) => {
    const legacyBroadcast = n.receiver === LEGACY_BROADCAST;
    const isRead = legacyBroadcast
        ? Array.isArray(n.seenBy) && n.seenBy.length > 0 // projected to this user only
        : Boolean(n.isRead);
    const entityId = n.data?.entityId ?? n.redirectId ?? null;
    return {
        _id: n._id,
        type: n.type,
        title: n.title,
        message: n.message,
        data: {
            entity: n.data?.entity ?? (n.redirectId ? NOTIFICATION_ENTITY.PODCAST : NOTIFICATION_ENTITY.NONE),
            entityId,
            ...(n.data?.meta ? { meta: n.data.meta } : {}),
        },
        redirectId: entityId,
        isRead,
        isSeen: isRead,
        createdAt: n.createdAt,
    };
};

// ───────────────────────────────────────────────────────────── create

export interface NotifyInput {
    /** Profile id, or 'superAdmin' for the dashboard inbox (never pushed). */
    receiver: string;
    type: NotificationType;
    title: string;
    message: string;
    data?: INotificationData;
    /** Also send a push to the receiver's devices (default true for users). */
    push?: boolean;
}

/**
 * Save an inbox notification and queue its push. The row is the outbox: if the process dies
 * before the push goes out, the worker still sends it (with retries) after the restart.
 */
const notify = async ({ receiver, type, title, message, data, push = true }: NotifyInput) => {
    const wantsPush = push && !isAdminInbox(receiver);
    const doc = await Notification.create({
        receiver: String(receiver),
        type,
        title,
        message,
        data: data ?? { entity: NOTIFICATION_ENTITY.NONE },
        push: wantsPush
            ? { status: 'pending', attempts: 0, nextAttemptAt: new Date() }
            : { status: 'none', attempts: 0 },
    });
    if (wantsPush) kickNotificationWorker();
    return doc;
};

/** For side effects of another request: logs instead of failing it. */
const notifySafe = (input: NotifyInput) =>
    notify(input).catch((err) => {
        errorLogger.error('Notification failed', { err, type: input.type, receiver: input.receiver });
        return null;
    });

/** Admin announcement to many users; delivered in the background (see notification.worker). */
const createBroadcast = async (
    input: { title: string; message: string; audience?: BroadcastAudience; data?: { entity: string; entityId?: string | null } },
    createdBy: string
) => {
    const audience = input.audience ?? 'all';
    const job = await NotificationBroadcast.create({
        title: input.title,
        message: input.message,
        data: input.data ?? { entity: NOTIFICATION_ENTITY.NONE },
        audience,
        phase: audience === 'creators' ? 'Creator' : 'NormalUser',
        createdBy,
    });
    kickNotificationWorker();
    return job;
};

const getBroadcasts = async (query: Record<string, unknown>) => {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);
    const [result, total] = await Promise.all([
        NotificationBroadcast.find()
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        NotificationBroadcast.countDocuments(),
    ]);
    return { meta: { page, limit, total, totalPage: Math.ceil(total / limit) }, result };
};

// ───────────────────────────────────────────────────────────── inbox

/**
 * The caller's inbox, newest first. The receiver always comes from the token — query params
 * can only page, never widen the filter.
 */
const getAllNotificationFromDB = async (query: Record<string, any>, user: JwtPayload) => {
    const receiver = inboxOf(user);
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);
    const filter = visibleTo(receiver);
    const [rows, total, unreadCount] = await Promise.all([
        Notification.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .select({
                receiver: 1,
                type: 1,
                title: 1,
                message: 1,
                data: 1,
                redirectId: 1,
                isRead: 1,
                createdAt: 1,
                // Legacy broadcast rows: only this user's id, never the whole list of readers.
                ...(isAdminInbox(receiver) ? {} : { seenBy: { $elemMatch: { $eq: oid(receiver) } } }),
            })
            .lean(),
        Notification.countDocuments(filter),
        Notification.countDocuments(unreadFor(receiver)),
    ]);
    return {
        meta: { page, limit, total, totalPage: Math.ceil(total / limit), unreadCount },
        result: rows.map((n) => toView(n)),
    };
};

const getUnseenCount = async (user: JwtPayload) => ({
    count: await Notification.countDocuments(unreadFor(inboxOf(user))),
});

/** Mark everything read. */
const seeNotification = async (user: JwtPayload) => {
    const receiver = inboxOf(user);
    const now = new Date();
    const own = await Notification.updateMany(
        { receiver, isRead: { $ne: true } },
        { $set: { isRead: true, readAt: now } }
    );
    if (!isAdminInbox(receiver)) {
        await Notification.updateMany(
            { receiver: LEGACY_BROADCAST, seenBy: { $ne: oid(receiver) } },
            { $addToSet: { seenBy: oid(receiver) } },
            { timestamps: false }
        );
    }
    return { modifiedCount: own.modifiedCount };
};

/** Mark one read (e.g. opened from a push). */
const seeSingleNotification = async (id: string, user: JwtPayload) => {
    if (!Types.ObjectId.isValid(id)) throw new AppError(httpStatus.BAD_REQUEST, 'Invalid notification id');
    const receiver = inboxOf(user);
    const own = await Notification.findOneAndUpdate(
        { _id: id, receiver },
        { $set: { isRead: true, readAt: new Date() } },
        { new: true }
    ).lean();
    if (own) return toView(own);
    if (!isAdminInbox(receiver)) {
        const legacy = await Notification.findOneAndUpdate(
            { _id: id, receiver: LEGACY_BROADCAST },
            { $addToSet: { seenBy: oid(receiver) } },
            { new: true, timestamps: false, projection: { seenBy: { $elemMatch: { $eq: oid(receiver) } } } }
        ).lean();
        if (legacy) return toView(legacy);
    }
    throw new AppError(httpStatus.NOT_FOUND, 'Notification not found');
};

/** Delete one from the caller's inbox (a legacy broadcast is only hidden for them). */
const deleteNoficiation = async (id: string, profileId: string, role?: string) => {
    if (!Types.ObjectId.isValid(id)) throw new AppError(httpStatus.BAD_REQUEST, 'Invalid notification id');
    const receiver = inboxOf({ profileId, role } as JwtPayload);
    const removed = await Notification.findOneAndDelete({ _id: id, receiver });
    if (removed) return null;
    if (!isAdminInbox(receiver)) {
        const hidden = await Notification.findOneAndUpdate(
            { _id: id, receiver: LEGACY_BROADCAST },
            { $addToSet: { deleteBy: oid(receiver) } },
            { timestamps: false }
        );
        if (hidden) return null;
    }
    throw new AppError(httpStatus.NOT_FOUND, 'Notification not found');
};

/** Account deleted: their inbox goes too. */
const deleteNotificationsOfUser = (profileId: string) =>
    Notification.deleteMany({ receiver: String(profileId) });

const notificationService = {
    notify,
    notifySafe,
    createBroadcast,
    getBroadcasts,
    getAllNotificationFromDB,
    getUnseenCount,
    seeNotification,
    seeSingleNotification,
    deleteNoficiation,
    deleteNotificationsOfUser,
};

export default notificationService;
