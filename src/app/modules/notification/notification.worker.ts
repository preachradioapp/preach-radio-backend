/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from 'mongoose';
import { isPushConfigured, ONESIGNAL_MAX_RECIPIENTS, sendPush } from '../../helper/oneSignal';
import { errorLogger, logger } from '../../shared/logger';
import Creator from '../creator/creator.model';
import deviceService from '../device/device.service';
import NormalUser from '../normalUser/normalUser.model';
import Notification from './notification.model';
import { NotificationBroadcast } from './notificationBroadcast.model';

/**
 * Background delivery for notifications, backed by MongoDB (no extra infrastructure):
 *
 * - **Push outbox.** `notify()` saves the inbox row with `push.status: 'pending'`. The worker
 *   claims due rows with a lease (`lockedUntil`), so several server instances never send the
 *   same push twice, and a crash mid-send only delays it until the lease expires.
 *   Network / 429 / 5xx errors retry with exponential backoff; after MAX_ATTEMPTS it gives up.
 *   Ids OneSignal reports invalid are deactivated.
 * - **Broadcasts.** Walks the audience in batches, writes one inbox row per user and pushes
 *   to their devices (one request per ≤2000 devices). Resumable through a cursor.
 */

export const PUSH_MAX_ATTEMPTS = 6;
const LEASE_MS = 60_000;
const TICK_MS = 5_000;
const PUSH_BATCH = 50;
const BROADCAST_BATCH = 500;

/** 30 s, 1 m, 2 m, 4 m, 8 m… capped at 1 h. */
export const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);

/** What a push carries so a tap can open the right screen. */
const pushData = (n: any) => ({
    notificationId: String(n._id),
    type: n.type,
    entity: n.data?.entity ?? 'NONE',
    entityId: n.data?.entityId ?? null,
});

const claimDuePush = (now: Date) =>
    Notification.findOneAndUpdate(
        {
            'push.status': 'pending',
            'push.nextAttemptAt': { $lte: now },
            $or: [{ 'push.lockedUntil': null }, { 'push.lockedUntil': { $lte: now } }],
        },
        { $set: { 'push.lockedUntil': new Date(now.getTime() + LEASE_MS) } },
        { sort: { 'push.nextAttemptAt': 1 }, new: true, timestamps: false }
    ).lean();

const finishPush = (id: Types.ObjectId, set: Record<string, unknown>) =>
    Notification.updateOne({ _id: id }, { $set: { 'push.lockedUntil': null, ...set } }, { timestamps: false });

/** Deliver one claimed notification. */
export const deliverPush = async (n: any) => {
    const now = new Date();
    if (!isPushConfigured()) {
        return finishPush(n._id, { 'push.status': 'skipped', 'push.lastError': 'OneSignal is not configured' });
    }
    const playerIds = await deviceService.activePlayerIds([n.receiver]);
    if (!playerIds.length) {
        return finishPush(n._id, { 'push.status': 'skipped', 'push.lastError': 'No active device' });
    }

    let retryError: string | null = null;
    let fatalError: string | null = null;
    for (let i = 0; i < playerIds.length; i += ONESIGNAL_MAX_RECIPIENTS) {
        const result = await sendPush({
            playerIds: playerIds.slice(i, i + ONESIGNAL_MAX_RECIPIENTS),
            title: n.title,
            message: n.message,
            data: pushData(n),
        });
        await deviceService.deactivatePlayerIds(result.invalidPlayerIds);
        if (!result.ok) {
            if (result.retryable) retryError = result.error;
            else fatalError = result.error;
        }
    }

    if (retryError) {
        const attempts = (n.push?.attempts ?? 0) + 1;
        if (attempts >= PUSH_MAX_ATTEMPTS) {
            errorLogger.error('Push gave up', { id: String(n._id), error: retryError });
            return finishPush(n._id, { 'push.status': 'failed', 'push.attempts': attempts, 'push.lastError': retryError });
        }
        return finishPush(n._id, {
            'push.attempts': attempts,
            'push.nextAttemptAt': new Date(now.getTime() + backoffMs(attempts)),
            'push.lastError': retryError,
        });
    }
    if (fatalError) {
        errorLogger.error('Push rejected', { id: String(n._id), error: fatalError });
        return finishPush(n._id, { 'push.status': 'failed', 'push.attempts': (n.push?.attempts ?? 0) + 1, 'push.lastError': fatalError });
    }
    return finishPush(n._id, { 'push.status': 'sent', 'push.sentAt': now, 'push.attempts': (n.push?.attempts ?? 0) + 1, 'push.lastError': null });
};

/** Drain due pushes (up to PUSH_BATCH per run). */
export const processPushQueue = async () => {
    let done = 0;
    while (done < PUSH_BATCH) {
        const n = await claimDuePush(new Date());
        if (!n) break;
        try {
            await deliverPush(n);
        } catch (err: any) {
            // Unexpected (DB) error: release the lease and retry later.
            errorLogger.error('Push delivery crashed', { id: String(n._id), err });
            await finishPush(n._id as Types.ObjectId, {
                'push.nextAttemptAt': new Date(Date.now() + backoffMs((n.push?.attempts ?? 0) + 1)),
                'push.lastError': String(err?.message ?? err),
            }).catch(() => undefined);
        }
        done += 1;
    }
    return done;
};

const audienceModel = (phase: 'NormalUser' | 'Creator') => (phase === 'Creator' ? Creator : NormalUser) as any;

/** One batch of one broadcast. Returns true when there was work. */
export const processBroadcastBatch = async () => {
    const now = new Date();
    const job: any = await NotificationBroadcast.findOneAndUpdate(
        {
            status: { $in: ['pending', 'running'] },
            $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
        },
        { $set: { status: 'running', lockedUntil: new Date(now.getTime() + LEASE_MS) } },
        { sort: { createdAt: 1 }, new: true }
    ).lean();
    if (!job) return false;

    try {
        const users = await audienceModel(job.phase)
            .find(job.cursor ? { _id: { $gt: job.cursor } } : {})
            .sort({ _id: 1 })
            .limit(BROADCAST_BATCH)
            .select('_id')
            .lean();

        if (users.length) {
            const ids: Types.ObjectId[] = users.map((u: any) => u._id);
            // Inbox rows; the push for the whole batch is sent below, so rows are not queued.
            await Notification.insertMany(
                ids.map((id) => ({
                    receiver: String(id),
                    type: 'GENERAL',
                    title: job.title,
                    message: job.message,
                    data: job.data ?? { entity: 'NONE' },
                    push: { status: 'none', attempts: 0 },
                })),
                { ordered: false }
            );
            let pushed = 0;
            if (isPushConfigured()) {
                const playerIds = await deviceService.activePlayerIds(ids);
                for (let i = 0; i < playerIds.length; i += ONESIGNAL_MAX_RECIPIENTS) {
                    const chunk = playerIds.slice(i, i + ONESIGNAL_MAX_RECIPIENTS);
                    const result = await sendPush({
                        playerIds: chunk,
                        title: job.title,
                        message: job.message,
                        data: { type: 'GENERAL', entity: job.data?.entity ?? 'NONE', entityId: job.data?.entityId ?? null, broadcastId: String(job._id) },
                    });
                    await deviceService.deactivatePlayerIds(result.invalidPlayerIds);
                    if (result.ok) pushed += chunk.length - result.invalidPlayerIds.length;
                    else errorLogger.error('Broadcast push failed', { id: String(job._id), error: result.error });
                }
            }
            await NotificationBroadcast.updateOne(
                { _id: job._id },
                {
                    $set: { cursor: ids[ids.length - 1], lockedUntil: null },
                    $inc: { recipients: ids.length, pushed },
                }
            );
            return true;
        }

        // This collection is done: next phase, or finished.
        if (job.audience === 'all' && job.phase === 'NormalUser') {
            await NotificationBroadcast.updateOne({ _id: job._id }, { $set: { phase: 'Creator', cursor: null, lockedUntil: null } });
        } else {
            await NotificationBroadcast.updateOne({ _id: job._id }, { $set: { status: 'done', finishedAt: new Date(), lockedUntil: null } });
            logger.info(`Broadcast ${job._id} done`);
        }
        return true;
    } catch (err: any) {
        // Release; the lease would expire anyway. The batch is retried from the same cursor
        // (a rare duplicate inbox row is better than a user missing an announcement).
        errorLogger.error('Broadcast batch failed', { id: String(job._id), err });
        await NotificationBroadcast.updateOne({ _id: job._id }, { $set: { lockedUntil: null, lastError: String(err?.message ?? err) } }).catch(() => undefined);
        return false;
    }
};

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let rerun = false;

/** One pass over both queues; overlapping calls are merged. */
export const runNotificationWorkerOnce = async () => {
    if (running) {
        rerun = true;
        return;
    }
    running = true;
    try {
        do {
            rerun = false;
            await processPushQueue();
            // A few broadcast batches per pass so pushes aren't starved.
            for (let i = 0; i < 5 && (await processBroadcastBatch()); i += 1);
        } while (rerun);
    } catch (err) {
        errorLogger.error('Notification worker pass failed', err);
    } finally {
        running = false;
    }
};

/** Run soon (a notification was just created) instead of waiting for the next tick. */
export const kickNotificationWorker = () => {
    if (!timer) return; // not started (tests, scripts): rows stay queued for the worker
    setTimeout(() => void runNotificationWorkerOnce(), 0);
};

export const startNotificationWorker = () => {
    if (timer) return;
    if (!isPushConfigured()) logger.warn('OneSignal is not configured: notifications are saved, pushes are skipped');
    timer = setInterval(() => void runNotificationWorkerOnce(), TICK_MS);
    timer.unref();
    void runNotificationWorkerOnce();
};

export const stopNotificationWorker = () => {
    if (timer) clearInterval(timer);
    timer = null;
};
