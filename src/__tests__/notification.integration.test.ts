/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
/**
 * Notification system: per-user inbox (+ legacy broadcast rows), push outbox worker
 * (OneSignal mocked), retries/backoff, leases, devices, broadcasts, domain events.   npm test
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// OneSignal "configured" before config is loaded.
process.env.ONESIGNAL_APP_ID = 'test-app';
process.env.ONESIGNAL_API_KEY = 'os_v2_test_key';

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const Notification = require('../app/modules/notification/notification.model').default;
const notifications = require('../app/modules/notification/notification.services').default;
const worker = require('../app/modules/notification/notification.worker');
const { NotificationBroadcast } = require('../app/modules/notification/notificationBroadcast.model');
const { Device } = require('../app/modules/device/device.model');
const devices = require('../app/modules/device/device.service').default;
const { emitAppEvent } = require('../app/events/appEvents');
require('../app/modules/notification/notification.listeners');

const oid = () => new mongoose.Types.ObjectId();
const raw = (name: string) => mongoose.connection.collection(name);
const tick = () => new Promise((r) => setTimeout(r, 30));

let mongo: any;
let alice: { profileId: string; role: string };
let bob: { profileId: string; role: string };

// ── fetch mock (OneSignal) ──────────────────────────────────────────────
type Call = { url: string; body: any; auth: string };
let calls: Call[] = [];
// eslint-disable-next-line no-unused-vars -- parameter name in a function type
let respond: (call: Call) => { status: number; body: any } = () => ({ status: 200, body: { id: 'x' } });
const realFetch = globalThis.fetch;
before(() => {
    (globalThis as any).fetch = async (url: string, init: any) => {
        const call = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
        calls.push(call);
        const { status, body } = respond(call);
        return { ok: status < 300, status, json: async () => body } as any;
    };
});
after(() => {
    (globalThis as any).fetch = realFetch;
});

before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([Notification.init(), Device.init(), NotificationBroadcast.init()]);
});
after(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});
beforeEach(async () => {
    await Promise.all(['notifications', 'devices', 'notificationbroadcasts', 'normalusers', 'creators'].map((c) => raw(c).deleteMany({})));
    alice = { profileId: String(oid()), role: 'user' };
    bob = { profileId: String(oid()), role: 'creator' };
    calls = [];
    respond = () => ({ status: 200, body: { id: 'x' } });
});
afterEach(() => undefined);

const notifyAlice = (extra: Record<string, unknown> = {}) =>
    notifications.notify({ receiver: alice.profileId, type: 'COMMENT', title: 'New comment', message: 'Hi', data: { entity: 'PODCAST', entityId: 'pod1' }, ...extra });

describe('inbox', () => {
    it('lists only the caller’s notifications, newest first, with data + isRead; query params cannot widen it', async () => {
        await notifyAlice();
        await notifications.notify({ receiver: bob.profileId, type: 'GENERAL', title: 'For Bob', message: 'm' });
        const list = await notifications.getAllNotificationFromDB({ receiver: bob.profileId, $where: '1' }, alice);
        assert.equal(list.meta.total, 1);
        const [n] = list.result;
        assert.equal(n.title, 'New comment');
        assert.deepEqual(n.data, { entity: 'PODCAST', entityId: 'pod1' });
        assert.equal(n.redirectId, 'pod1'); // older app builds
        assert.equal(n.isRead, false);
        assert.equal(n.isSeen, false);
        assert.equal(list.meta.unreadCount, 1);
        assert.ok(!('push' in n) && !('receiver' in n));
    });

    it('mark one read, mark all read, unseen count', async () => {
        const a = await notifyAlice();
        await notifyAlice({ title: 'Second' });
        assert.equal((await notifications.getUnseenCount(alice)).count, 2);
        const one = await notifications.seeSingleNotification(String(a._id), alice);
        assert.equal(one.isRead, true);
        assert.equal((await notifications.getUnseenCount(alice)).count, 1);
        await notifications.seeNotification(alice);
        assert.equal((await notifications.getUnseenCount(alice)).count, 0);
        // Another user can't read or delete Alice's notification.
        await assert.rejects(notifications.seeSingleNotification(String(a._id), bob), /not found/);
        await assert.rejects(notifications.deleteNoficiation(String(a._id), bob.profileId, bob.role), /not found/);
        await notifications.deleteNoficiation(String(a._id), alice.profileId, alice.role);
        assert.equal((await notifications.getAllNotificationFromDB({}, alice)).meta.total, 1);
    });

    it('legacy broadcast rows (receiver "all") still show, read and hide per user without leaking readers', async () => {
        const legacy = await raw('notifications').insertOne({ receiver: 'all', type: 'GENERAL', title: 'Old news', message: 'm', redirectId: 'pod9', seenBy: [new mongoose.Types.ObjectId(bob.profileId)], deleteBy: [], createdAt: new Date() });
        const list = await notifications.getAllNotificationFromDB({}, alice);
        assert.equal(list.result[0].isSeen, false);
        assert.equal(list.result[0].data.entityId, 'pod9');
        assert.equal((await notifications.getUnseenCount(bob)).count, 0);
        await notifications.seeNotification(alice);
        assert.equal((await notifications.getUnseenCount(alice)).count, 0);
        await notifications.deleteNoficiation(String(legacy.insertedId), alice.profileId, alice.role);
        assert.equal((await notifications.getAllNotificationFromDB({}, alice)).meta.total, 0);
        assert.equal((await notifications.getAllNotificationFromDB({}, bob)).meta.total, 1);
    });

    it('admin notifications go to the shared dashboard inbox and are never pushed', async () => {
        const n = await notifications.notify({ receiver: 'superAdmin', type: 'REPORT', title: 'Report', message: 'm' });
        assert.equal(n.push.status, 'none');
        const list = await notifications.getAllNotificationFromDB({}, { profileId: String(oid()), role: 'superAdmin' });
        assert.equal(list.meta.total, 1);
    });
});

describe('push outbox', () => {
    it('sends to the receiver’s active devices with deep-link data, then marks sent', async () => {
        await devices.registerDevice(alice.profileId, 'user', 'player-alice-1', 'android');
        await devices.registerDevice(alice.profileId, 'user', 'player-alice-2', 'ios');
        const n = await notifyAlice();
        assert.equal(n.push.status, 'pending');
        await worker.processPushQueue();
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].body.include_subscription_ids.sort(), ['player-alice-1', 'player-alice-2']);
        assert.equal(calls[0].body.data.entity, 'PODCAST');
        assert.equal(calls[0].body.data.notificationId, String(n._id));
        assert.equal(calls[0].auth, 'Key os_v2_test_key');
        const saved = await Notification.findById(n._id).lean();
        assert.equal(saved.push.status, 'sent');
        assert.equal(saved.push.lockedUntil, null);
    });

    it('no device → skipped (no request)', async () => {
        const n = await notifyAlice();
        await worker.processPushQueue();
        assert.equal(calls.length, 0);
        assert.equal((await Notification.findById(n._id).lean()).push.status, 'skipped');
    });

    it('5xx retries with backoff, then gives up after the max attempts', async () => {
        await devices.registerDevice(alice.profileId, 'user', 'player-alice-1', 'android');
        respond = () => ({ status: 503, body: { errors: ['busy'] } });
        const n = await notifyAlice();
        await worker.processPushQueue();
        let saved = await Notification.findById(n._id).lean();
        assert.equal(saved.push.status, 'pending');
        assert.equal(saved.push.attempts, 1);
        assert.ok(saved.push.nextAttemptAt > new Date(Date.now() + 20_000)); // ~30 s later
        // Not due yet → not retried now.
        await worker.processPushQueue();
        assert.equal(calls.length, 1);
        // Make it due repeatedly until it gives up.
        for (let i = 0; i < worker.PUSH_MAX_ATTEMPTS; i += 1) {
            await Notification.updateOne({ _id: n._id }, { $set: { 'push.nextAttemptAt': new Date(0) } });
            await worker.processPushQueue();
        }
        saved = await Notification.findById(n._id).lean();
        assert.equal(saved.push.status, 'failed');
        assert.equal(saved.push.attempts, worker.PUSH_MAX_ATTEMPTS);
    });

    it('4xx is not retried; ids reported invalid are deactivated', async () => {
        await devices.registerDevice(alice.profileId, 'user', 'player-gone', 'android');
        await devices.registerDevice(alice.profileId, 'user', 'player-ok', 'ios');
        respond = () => ({ status: 200, body: { id: 'x', errors: { invalid_player_ids: ['player-gone'] } } });
        await notifyAlice();
        await worker.processPushQueue();
        assert.equal((await Device.findOne({ playerId: 'player-gone' }).lean()).isActive, false);
        assert.equal((await Device.findOne({ playerId: 'player-ok' }).lean()).isActive, true);

        respond = () => ({ status: 400, body: { errors: ['bad request'] } });
        const n = await notifyAlice();
        await worker.processPushQueue();
        assert.equal((await Notification.findById(n._id).lean()).push.status, 'failed');
    });

    it('two workers at once send each push exactly once (lease)', async () => {
        await devices.registerDevice(alice.profileId, 'user', 'player-alice-1', 'android');
        for (let i = 0; i < 5; i += 1) await notifyAlice({ title: `N${i}` });
        await Promise.all([worker.processPushQueue(), worker.processPushQueue()]);
        assert.equal(calls.length, 5);
        assert.equal(await Notification.countDocuments({ 'push.status': 'sent' }), 5);
    });

    it('backoff grows and is capped at one hour', () => {
        assert.equal(worker.backoffMs(1), 30_000);
        assert.equal(worker.backoffMs(2), 60_000);
        assert.equal(worker.backoffMs(20), 3_600_000);
    });
});

describe('devices', () => {
    it('a re-login moves the install to the new account; unregister only affects your own', async () => {
        await devices.registerDevice(alice.profileId, 'user', 'shared-phone', 'android');
        await devices.registerDevice(bob.profileId, 'creator', 'shared-phone', 'android');
        assert.deepEqual(await devices.activePlayerIds([alice.profileId]), []);
        assert.deepEqual(await devices.activePlayerIds([bob.profileId]), ['shared-phone']);
        await devices.unregisterDevice(alice.profileId, 'shared-phone'); // not Alice's any more
        assert.deepEqual(await devices.activePlayerIds([bob.profileId]), ['shared-phone']);
        await devices.unregisterDevice(bob.profileId, 'shared-phone');
        assert.deepEqual(await devices.activePlayerIds([bob.profileId]), []);
    });
});

describe('broadcasts', () => {
    const seedUsers = async () => {
        const listeners = await raw('normalusers').insertMany([{ name: 'L1' }, { name: 'L2' }, { name: 'L3' }]);
        const creators = await raw('creators').insertMany([{ name: 'C1' }, { name: 'C2' }]);
        const l = Object.values(listeners.insertedIds).map(String);
        const c = Object.values(creators.insertedIds).map(String);
        await devices.registerDevice(l[0], 'user', 'p-l1', 'android');
        await devices.registerDevice(c[0], 'creator', 'p-c1', 'ios');
        return { l, c };
    };
    const drain = async () => {
        for (let i = 0; i < 20 && (await worker.processBroadcastBatch()); i += 1);
    };

    it('“all” writes one inbox row per listener and creator and pushes their devices', async () => {
        const { l, c } = await seedUsers();
        const job = await notifications.createBroadcast({ title: 'Easter service', message: 'Join us live', data: { entity: 'NONE' } }, 'admin');
        await drain();
        const saved = await NotificationBroadcast.findById(job._id).lean();
        assert.equal(saved.status, 'done');
        assert.equal(saved.recipients, 5);
        assert.equal(saved.pushed, 2);
        assert.equal(await Notification.countDocuments({ title: 'Easter service' }), 5);
        for (const id of [...l, ...c]) assert.equal((await notifications.getUnseenCount({ profileId: id, role: 'user' })).count, 1);
        assert.deepEqual(calls.flatMap((x) => x.body.include_subscription_ids).sort(), ['p-c1', 'p-l1']);
        // Inbox rows of a broadcast are not queued again for individual pushes.
        assert.equal(await Notification.countDocuments({ 'push.status': 'pending' }), 0);
    });

    it('“creators” reaches creators only', async () => {
        const { c } = await seedUsers();
        await notifications.createBroadcast({ title: 'For creators', message: 'New upload tools', audience: 'creators' }, 'admin');
        await drain();
        assert.equal(await Notification.countDocuments({ title: 'For creators' }), 2);
        assert.deepEqual((await Notification.distinct('receiver', { title: 'For creators' })).sort(), c.sort());
    });
});

describe('domain events', () => {
    it('comment.created notifies the podcast owner (not when commenting on your own)', async () => {
        emitAppEvent('comment.created', { podcastId: 'pod1', podcastTitle: 'Grace', podcastOwnerId: bob.profileId, commentId: 'c1', actorId: alice.profileId, actorName: 'Alice', text: 'Amen' });
        emitAppEvent('comment.created', { podcastId: 'pod1', podcastTitle: 'Grace', podcastOwnerId: bob.profileId, commentId: 'c2', actorId: bob.profileId, actorName: 'Bob', text: 'Self' });
        await tick();
        const list = await notifications.getAllNotificationFromDB({}, bob);
        assert.equal(list.meta.total, 1);
        assert.match(list.result[0].message, /Alice commented on “Grace”: Amen/);
        assert.deepEqual(list.result[0].data, { entity: 'PODCAST', entityId: 'pod1', meta: { commentId: 'c1' } });
    });

    it('a failing listener never throws into the emitter', async () => {
        // receiver is invalid for the schema (empty) → notify rejects → logged, not thrown.
        assert.doesNotThrow(() => emitAppEvent('feedback.replied', { feedbackId: 'f1', profileId: '', reply: 'Thanks' }));
        await tick();
    });
});
