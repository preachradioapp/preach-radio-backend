/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
/**
 * Integration tests for comments (threads, likes, pagination, permissions, cascades)
 * against an in-memory MongoDB.   npm test
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Redis isn't used by comments, but podcast model hooks import it.
const fakeRedis: any = {
    on: () => fakeRedis,
    get: async () => null,
    set: async () => 'OK',
    del: async () => 0,
    unlink: async () => 0,
    keys: async () => [],
    scanStream: () => (async function* () { yield []; })(),
};
const redisPath = require.resolve('../app/utilities/redisClient');
require.cache[redisPath] = {
    id: redisPath,
    filename: redisPath,
    loaded: true,
    exports: { __esModule: true, default: fakeRedis },
} as any;

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const Podcast = require('../app/modules/podcast/podcast.model').default;
const Comment = require('../app/modules/comment/comment.model').default;
const Notification = require('../app/modules/notification/notification.model').default;
const comments = require('../app/modules/comment/comment.service').default;
// Comment notifications go through domain events; app.ts registers these listeners at startup.
require('../app/modules/notification/notification.listeners');

const oid = () => new mongoose.Types.ObjectId();
const raw = (name: string) => mongoose.connection.collection(name);

let mongo: any;
let podcastId: string;
let creator: { profileId: string; role: string };
let alice: { profileId: string; role: string };
let bob: { profileId: string; role: string };

const addUser = async (name: string) => {
    const { insertedId } = await raw('normalusers').insertOne({ name, profile_image: `${name}.png` });
    return { profileId: String(insertedId), role: 'user' };
};

before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([Podcast.init(), Comment.init()]);
});

after(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});

beforeEach(async () => {
    await Promise.all(
        ['podcasts', 'comments', 'normalusers', 'creators', 'notifications'].map((c) => raw(c).deleteMany({}))
    );
    const creatorDoc = await raw('creators').insertOne({ name: 'Pastor Grace', profile_image: '' });
    creator = { profileId: String(creatorDoc.insertedId), role: 'creator' };
    alice = await addUser('Alice');
    bob = await addUser('Bob');
    const p = await Podcast.create({
        creator: creatorDoc.insertedId,
        category: oid(),
        subCategory: oid(),
        podcast_url: 'https://cdn/podcast_audio/a.mp3',
        title: 'Walking in Faith',
        description: 'd',
        location: { type: 'Point', coordinates: [0, 0] },
        address: 'Lagos',
        duration: 4,
    });
    podcastId = String(p._id);
});

describe('comments', () => {
    it('creates a comment in the list shape and notifies the podcast creator', async () => {
        const c = await comments.createComment(alice, { podcast: podcastId, text: 'Amen' });
        assert.equal(c.commentor.name, 'Alice');
        assert.equal(c.commentorName, 'Alice');
        assert.equal(c.totalLike, 0);
        assert.equal(c.totalReplies, 0);
        assert.equal(c.isLiked, false);
        assert.equal(c.isMyComment, true);
        assert.equal(c.canDelete, true);
        assert.equal(c.parent, null);
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(await Notification.countDocuments({ receiver: creator.profileId, type: 'COMMENT' }), 1);
    });

    it('rejects comments on a missing podcast', async () => {
        await assert.rejects(
            comments.createComment(alice, { podcast: String(oid()), text: 'x' }),
            /Podcast not found/
        );
    });

    it('nests replies, counts direct replies and paginates both levels', async () => {
        const top = await comments.createComment(alice, { podcast: podcastId, text: 'Top' });
        const replies = [];
        for (let i = 0; i < 12; i++) {
            replies.push(await comments.createReply(bob, { parent: String(top._id), text: `r${i}` }));
        }
        await comments.createReply(alice, { parent: String(replies[0]._id), text: 'nested' });

        const list = await comments.getPodcastComments(bob, podcastId, {});
        assert.equal(list.meta.total, 1, 'replies are not top-level comments');
        assert.equal(list.result[0].totalReplies, 12);

        const page1 = await comments.getReplies(bob, String(top._id), { limit: 5 });
        assert.equal(page1.meta.total, 12);
        assert.equal(page1.meta.totalPage, 3);
        assert.deepEqual(page1.result.map((r: any) => r.text), ['r0', 'r1', 'r2', 'r3', 'r4'], 'oldest first');
        assert.equal(page1.result[0].totalReplies, 1);
        const page3 = await comments.getReplies(bob, String(top._id), { limit: 5, page: 3 });
        assert.deepEqual(page3.result.map((r: any) => r.text), ['r10', 'r11']);
    });

    it('like toggle is atomic and reported per viewer', async () => {
        const c = await comments.createComment(alice, { podcast: podcastId, text: 'Hi' });
        const results = await Promise.all(
            Array.from({ length: 5 }, () => comments.likeUnlikeComment(String(c._id), bob))
        );
        const stored = await Comment.findById(c._id).lean();
        const bobs = stored.likers.filter((l: any) => String(l.likerId) === bob.profileId);
        assert.ok(bobs.length <= 1, 'never liked twice');
        assert.ok(results.every((r: any) => typeof r.totalLikes === 'number'));

        await Comment.updateOne({ _id: c._id }, { $set: { likers: [] } });
        assert.equal((await comments.likeUnlikeComment(String(c._id), bob)).liked, true);
        const asBob = await comments.getPodcastComments(bob, podcastId, {});
        const asAlice = await comments.getPodcastComments(alice, podcastId, {});
        assert.equal(asBob.result[0].isLiked, true);
        assert.equal(asAlice.result[0].isLiked, false);
        assert.equal(asAlice.result[0].totalLike, 1);
        assert.equal((await comments.likeUnlikeComment(String(c._id), bob)).liked, false);
    });

    it('only the text is editable and edits are flagged', async () => {
        const c = await comments.createComment(alice, { podcast: podcastId, text: 'old' });
        const edited = await comments.updateComment(alice, String(c._id), { text: 'new', likers: [{ likerId: oid() }] } as any);
        assert.equal(edited.text, 'new');
        assert.equal(edited.isEdited, true);
        assert.equal(edited.totalLike, 0);
        await assert.rejects(comments.updateComment(bob, String(c._id), { text: 'hack' }), /not allowed/);
    });

    it('delete: author, podcast creator and admin may; others may not; threads go with it', async () => {
        const top = await comments.createComment(alice, { podcast: podcastId, text: 'Top' });
        const r = await comments.createReply(bob, { parent: String(top._id), text: 'r' });
        await comments.createReply(alice, { parent: String(r._id), text: 'rr' });

        await assert.rejects(comments.deleteComment(bob, String(top._id)), /not allowed/);
        const asBob = await comments.getPodcastComments(bob, podcastId, {});
        assert.equal(asBob.result[0].canDelete, false);
        const asCreator = await comments.getPodcastComments(creator, podcastId, {});
        assert.equal(asCreator.result[0].canDelete, true);

        const res = await comments.deleteComment(creator, String(top._id));
        assert.equal(res.deletedCount, 3);
        assert.equal(await Comment.countDocuments({}), 0);

        const again = await comments.createComment(alice, { podcast: podcastId, text: 'x' });
        await comments.deleteComment({ profileId: String(oid()), role: 'admin' }, String(again._id));
        assert.equal(await Comment.countDocuments({}), 0);
    });

    it('marks the podcast creator as author', async () => {
        await comments.createComment(creator, { podcast: podcastId, text: 'Thanks all' });
        const list = await comments.getPodcastComments(alice, podcastId, {});
        assert.equal(list.result[0].isAuthor, true);
        assert.equal(list.result[0].commentor.type, 'Creator');
    });

    it('account deletion removes the user comments, their threads and their likes', async () => {
        const mine = await comments.createComment(bob, { podcast: podcastId, text: 'bob' });
        await comments.createReply(alice, { parent: String(mine._id), text: 'reply to bob' });
        const hers = await comments.createComment(alice, { podcast: podcastId, text: 'alice' });
        await comments.likeUnlikeComment(String(hers._id), bob);

        await comments.deleteCommentsOfUser(bob.profileId);
        const left = await Comment.find({}).lean();
        assert.deepEqual(left.map((c: any) => c.text), ['alice']);
        assert.equal(left[0].likers.length, 0);
    });
});
