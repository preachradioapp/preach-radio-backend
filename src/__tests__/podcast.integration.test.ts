/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
/**
 * Integration tests for the podcast/likes data layer against a real (in-memory) MongoDB.
 * Redis is replaced by an in-memory fake so tests also assert cache invalidation.
 *
 *   npm test
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Fake Redis — must be registered before any app module is loaded.
// ---------------------------------------------------------------------------
const store = new Map<string, string>();
const unlinked: string[] = [];
const globToRegex = (glob: string) =>
    new RegExp(
        `^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
    );
const fakeRedis = {
    on: () => fakeRedis,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => (store.set(k, v), 'OK'),
    del: async (...keys: string[]) =>
        keys.filter((k) => store.delete(k)).length,
    unlink: async (...keys: string[]) => {
        unlinked.push(...keys);
        return keys.filter((k) => store.delete(k)).length;
    },
    keys: async (pattern: string) =>
        [...store.keys()].filter((k) => globToRegex(pattern).test(k)),
    scanStream: ({ match }: { match: string }) =>
        (async function* () {
            yield [...store.keys()].filter((k) => globToRegex(match).test(k));
        })(),
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
const Like = require('../app/modules/like/like.model').default;
const podcastService =
    require('../app/modules/podcast/podcast.service').default;
const { escapeRegex, sanitizeFilter } = require('../app/helper/sanitizeQuery');

const oid = () => new mongoose.Types.ObjectId();
const raw = (name: string) => mongoose.connection.collection(name);

let mongo: any;
let categoryId: any;
let subCategoryId: any;
let creatorId: any;
let stationId: any;

const listener = () => ({ profileId: String(oid()), role: 'user' });
const superAdmin = { profileId: String(oid()), role: 'superAdmin' };

const makePodcast = (overrides: Record<string, unknown> = {}) =>
    Podcast.create({
        category: categoryId,
        subCategory: subCategoryId,
        coverImage: 'https://cdn/x.png',
        podcast_url: 'https://cdn/podcast_audio/a.mp3',
        title: 'Walking in Faith',
        description: 'A message about hope',
        location: { type: 'Point', coordinates: [3.38, 6.52] },
        address: 'Lagos',
        duration: 4.07,
        station: stationId,
        ...overrides,
    });

before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([Podcast.init(), Like.init()]);
});

after(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});

beforeEach(async () => {
    await Promise.all(
        [
            'podcasts',
            'likes',
            'categories',
            'subcategories',
            'creators',
            'stations',
            'bookmarks',
            'albums',
        ].map((c) => raw(c).deleteMany({}))
    );
    store.clear();
    unlinked.length = 0;
    categoryId = (await raw('categories').insertOne({ name: 'Sermons' }))
        .insertedId;
    subCategoryId = (
        await raw('subcategories').insertOne({
            name: 'Weekly',
            category: categoryId,
        })
    ).insertedId;
    creatorId = (
        await raw('creators').insertOne({
            name: 'Grace Adeyemi',
            profile_image: '',
        })
    ).insertedId;
    stationId = (await raw('stations').insertOne({ name: 'Preach Radio' }))
        .insertedId;
});

// ---------------------------------------------------------------------------
describe('likes', () => {
    it('like then unlike keeps totalLikes in sync with the likes collection and clears the feed cache', async () => {
        const p = await makePodcast();
        const user = listener();
        store.set(`likes:${user.profileId}`, '[]');

        assert.deepEqual(
            await podcastService.toggleLikePodcast(String(p._id), user),
            { isLike: true }
        );
        assert.equal((await Podcast.findById(p._id)).totalLikes, 1);
        assert.equal(await Like.countDocuments({ podcast: p._id }), 1);
        assert.ok(
            unlinked.includes(`likes:${user.profileId}`),
            'feed like cache invalidated'
        );

        assert.deepEqual(
            await podcastService.toggleLikePodcast(String(p._id), user),
            { isLike: false }
        );
        assert.equal((await Podcast.findById(p._id)).totalLikes, 0);
        assert.equal(await Like.countDocuments({ podcast: p._id }), 0);
    });

    it('records the liker type (creator vs listener)', async () => {
        const p = await makePodcast();
        const creator = { profileId: String(creatorId), role: 'creator' };
        await podcastService.toggleLikePodcast(String(p._id), creator);
        assert.equal(
            (await Like.findOne({ podcast: p._id })).userType,
            'Creator'
        );
    });

    it('concurrent taps never double-count (counter always equals likes)', async () => {
        const p = await makePodcast();
        const user = listener();
        await Promise.all(
            Array.from({ length: 6 }, () =>
                podcastService.toggleLikePodcast(String(p._id), user)
            )
        );
        const likes = await Like.countDocuments({ podcast: p._id });
        assert.ok(likes <= 1, 'unique index prevents duplicate likes');
        assert.equal((await Podcast.findById(p._id)).totalLikes, likes);
    });

    it('many users liking at once are all counted', async () => {
        const p = await makePodcast();
        const users = Array.from({ length: 25 }, listener);
        await Promise.all(
            users.map((u) => podcastService.toggleLikePodcast(String(p._id), u))
        );
        assert.equal((await Podcast.findById(p._id)).totalLikes, 25);
        assert.equal(await Like.countDocuments({ podcast: p._id }), 25);
    });

    it('a like stored in the legacy embedded array (pre-migration) is treated as an existing like', async () => {
        const user = listener();
        const { insertedId } = await raw('podcasts').insertOne({
            category: categoryId,
            subCategory: subCategoryId,
            coverImage: 'x',
            title: 't',
            description: 'd',
            address: 'a',
            location: { type: 'Point', coordinates: [0, 0] },
            duration: 1,
            totalLikes: 1,
            likers: [
                {
                    user: new mongoose.Types.ObjectId(user.profileId),
                    userType: 'NormalUser',
                },
            ],
        });
        assert.deepEqual(
            await podcastService.toggleLikePodcast(String(insertedId), user),
            { isLike: false }
        );
        const doc = await raw('podcasts').findOne({ _id: insertedId });
        assert.equal(doc.totalLikes, 0);
        assert.equal(doc.likers.length, 0);
        assert.equal(await Like.countDocuments({}), 0);
    });

    it('rejects unknown podcasts and invalid ids', async () => {
        await assert.rejects(
            podcastService.toggleLikePodcast(String(oid()), listener()),
            /not found/i
        );
        await assert.rejects(
            podcastService.toggleLikePodcast('nope', listener()),
            /Invalid podcast id/
        );
    });
});

// ---------------------------------------------------------------------------
describe('getSinglePodcast', () => {
    it('anonymous callers get no personal data and no list of likers', async () => {
        const p = await makePodcast();
        await podcastService.toggleLikePodcast(String(p._id), listener());
        const res = await podcastService.getSinglePodcast(String(p._id), null);
        assert.equal(res.isLike, false);
        assert.deepEqual(res.likers, []);
        assert.equal(res.category.name, 'Sermons');
    });

    it('signed-in callers get isLike, and likers contains only their own entry (backward compatible)', async () => {
        const p = await makePodcast();
        const me = listener();
        await podcastService.toggleLikePodcast(String(p._id), me);
        await podcastService.toggleLikePodcast(String(p._id), listener()); // someone else
        const res = await podcastService.getSinglePodcast(String(p._id), me);
        assert.equal(res.isLike, true);
        assert.equal(res.totalLikes, 2);
        assert.equal(res.likers.length, 1);
        assert.equal(String(res.likers[0].user), me.profileId);
    });
});

// ---------------------------------------------------------------------------
describe('hidden podcasts', () => {
    it('are excluded from finds, counts, lists and detail for the app, but visible to admins', async () => {
        await makePodcast({ title: 'Visible' });
        const hidden = await makePodcast({ title: 'Hidden', status: 'hidden' });

        assert.equal(await Podcast.countDocuments(), 1);
        assert.equal((await Podcast.find()).length, 1);
        assert.equal(await Podcast.findById(hidden._id), null);

        const appList = await podcastService.getAllPodcasts({});
        assert.deepEqual(
            appList.result.map((r: any) => r.title),
            ['Visible']
        );
        assert.equal(appList.meta.total, 1);

        const adminList = await podcastService.getAllPodcasts(
            {},
            { includeHidden: true }
        );
        assert.equal(adminList.meta.total, 2);
        const onlyHidden = await podcastService.getAllPodcasts(
            { status: 'hidden' },
            { includeHidden: true }
        );
        assert.deepEqual(
            onlyHidden.result.map((r: any) => r.title),
            ['Hidden']
        );

        await assert.rejects(
            podcastService.getSinglePodcast(String(hidden._id), null),
            /not found/i
        );
        assert.equal(
            (
                await podcastService.getSinglePodcast(
                    String(hidden._id),
                    superAdmin
                )
            ).title,
            'Hidden'
        );
    });

    it('hidden podcasts are also excluded from aggregations', async () => {
        await makePodcast();
        await makePodcast({ status: 'hidden' });
        const rows = await Podcast.aggregate([
            { $group: { _id: null, n: { $sum: 1 } } },
        ]);
        assert.equal(rows[0].n, 1);
    });

    it('an admin can hide and then un-hide a podcast', async () => {
        const p = await makePodcast();
        assert.equal(
            (await podcastService.setPodcastStatus(String(p._id), 'hidden'))
                .status,
            'hidden'
        );
        assert.equal(await Podcast.findById(p._id), null);
        assert.equal(
            (await podcastService.setPodcastStatus(String(p._id), 'published'))
                .status,
            'published'
        );
        assert.ok(await Podcast.findById(p._id));
    });

    it('an admin can edit and delete a hidden podcast', async () => {
        const p = await makePodcast({ status: 'hidden' });
        const updated = await podcastService.updatePodcastIntoDB(
            superAdmin,
            String(p._id),
            { title: 'Renamed' }
        );
        assert.equal(updated.title, 'Renamed');
        await podcastService.deletePodcastFromDB(superAdmin, String(p._id));
        assert.equal(await raw('podcasts').countDocuments(), 0);
    });
});

// ---------------------------------------------------------------------------
describe('getAllPodcasts', () => {
    it('keeps the response shape the apps rely on', async () => {
        await makePodcast({ creator: creatorId, station: null });
        const res = await podcastService.getAllPodcasts({
            page: '1',
            limit: '10',
        });
        assert.deepEqual(res.meta, {
            page: 1,
            limit: 10,
            total: 1,
            totalPage: 1,
        });
        const item = res.result[0];
        assert.deepEqual(Object.keys(item.category).sort(), ['_id', 'name']);
        assert.deepEqual(Object.keys(item.subCategory).sort(), ['_id', 'name']);
        assert.equal(item.creator.name, 'Grace Adeyemi');
        assert.equal(item.mediaType, 'audio');
        assert.ok(!('likers' in item));
    });

    it('paginates newest first with correct totals', async () => {
        for (let i = 0; i < 5; i += 1) {
            await makePodcast({
                title: `P${i}`,
                createdAt: new Date(2026, 0, i + 1),
            });
        }
        const page2 = await podcastService.getAllPodcasts({
            page: 2,
            limit: 2,
        });
        assert.deepEqual(
            page2.result.map((r: any) => r.title),
            ['P2', 'P1']
        );
        assert.deepEqual(page2.meta, {
            page: 2,
            limit: 2,
            total: 5,
            totalPage: 3,
        });
    });

    it('sort=popular orders episodes by views, newest first on ties, and pages stably', async () => {
        const make = (title: string, totalView: number, day: number) =>
            makePodcast({
                title,
                type: 'episode',
                totalView,
                duration: 30,
                durationSeconds: 1800,
                createdAt: new Date(2026, 0, day),
            });
        await make('Quiet', 1, 5);
        await make('Hit', 50, 1);
        await make('TieOld', 10, 2);
        await make('TieNew', 10, 3);
        await makePodcast({
            title: 'ViralClip',
            type: 'clip',
            totalView: 999,
            duration: 0.45,
            durationSeconds: 45,
        });

        const query = { type: 'episode', sort: 'popular' };
        const all = await podcastService.getAllPodcasts({ ...query });
        assert.deepEqual(
            all.result.map((r: any) => r.title),
            ['Hit', 'TieNew', 'TieOld', 'Quiet']
        );
        const page2 = await podcastService.getAllPodcasts({
            ...query,
            page: 2,
            limit: 2,
        });
        assert.deepEqual(
            page2.result.map((r: any) => r.title),
            ['TieOld', 'Quiet']
        );
        // Unknown sort values fall back to newest first.
        const fallback = await podcastService.getAllPodcasts({
            type: 'episode',
            sort: '$where',
        });
        assert.equal(fallback.result[0].title, 'Quiet');
    });

    it('searches title, description and creator name, safely escaping regex input', async () => {
        await makePodcast({ title: 'Grace upon grace' });
        await makePodcast({
            title: 'Other',
            creator: creatorId,
            station: null,
        });
        await makePodcast({ title: 'Unrelated', description: 'nothing' });
        assert.equal(
            (await podcastService.getAllPodcasts({ searchTerm: 'grace' })).meta
                .total,
            2
        );
        assert.equal(
            (await podcastService.getAllPodcasts({ searchTerm: '(a+)+$' })).meta
                .total,
            0
        );
    });

    it('filters reels and excludes podcasts whose category was hard-deleted', async () => {
        await makePodcast({
            title: 'Short',
            type: 'clip',
            duration: 0.45,
            durationSeconds: 45,
        });
        await makePodcast({ title: 'Long', duration: 75 });
        await makePodcast({ title: 'Orphan', category: oid() });
        const all = await podcastService.getAllPodcasts({});
        assert.deepEqual(all.result.map((r: any) => r.title).sort(), [
            'Long',
            'Short',
        ]);
        const reels = await podcastService.getAllPodcasts({ reels: '1' });
        assert.deepEqual(
            reels.result.map((r: any) => r.title),
            ['Short']
        );
    });

    it('caps the page size', async () => {
        const res = await podcastService.getAllPodcasts({ limit: '90000000' });
        assert.equal(res.meta.limit, 100);
    });

    it('returns comment and bookmark counts per podcast (list and detail)', async () => {
        const Comment = require('../app/modules/comment/comment.model').default;
        const Bookmark = require('../app/modules/bookmark/bookmark.model').default;
        const busy = await makePodcast({ creator: creatorId, station: null });
        const quiet = await makePodcast({ creator: creatorId, station: null });
        const user = new mongoose.Types.ObjectId();
        await Comment.insertMany(
            [1, 2, 3].map((i) => ({
                podcast: busy._id,
                commentor: user,
                commentorType: 'NormalUser',
                text: `c${i}`,
            }))
        );
        await Bookmark.create({ podcast: busy._id, user });

        const { result } = await podcastService.getAllPodcasts({});
        const byId = new Map(result.map((r: any) => [String(r._id), r]));
        const b: any = byId.get(String(busy._id));
        const q: any = byId.get(String(quiet._id));
        assert.equal(b.totalComments, 3);
        assert.equal(b.totalBookmarks, 1);
        assert.equal(q.totalComments, 0);
        assert.equal(q.totalBookmarks, 0);

        const single = await podcastService.getSinglePodcast(String(busy._id), null);
        assert.equal(single.totalComments, 3);
        assert.equal(single.totalBookmarks, 1);
    });
});

// ---------------------------------------------------------------------------
describe('writes', () => {
    it('ignores server-controlled fields sent by clients (mass assignment)', async () => {
        const p = await makePodcast({ creator: creatorId, station: null });
        const creator = { profileId: String(creatorId), role: 'creator' };
        const updated = await podcastService.updatePodcastIntoDB(
            creator,
            String(p._id),
            {
                title: 'New title',
                totalView: 999999,
                totalLikes: 5000,
                status: 'published',
                creator: oid(),
            } as any
        );
        assert.equal(updated.title, 'New title');
        assert.equal(updated.totalView, 0);
        assert.equal(updated.totalLikes, 0);
        assert.equal(String(updated.creator), String(creatorId));
    });

    it('detects mediaType from the media URL', async () => {
        assert.equal(
            (
                await makePodcast({
                    podcast_url: 'https://cdn/podcast_videos/v.mp4',
                })
            ).mediaType,
            'video'
        );
        assert.equal((await makePodcast()).mediaType, 'audio');
    });

    it('deleting a podcast removes its likes and clears the home cache', async () => {
        const p = await makePodcast();
        await podcastService.toggleLikePodcast(String(p._id), listener());
        store.set('home:data', '{}');
        await podcastService.deletePodcastFromDB(superAdmin, String(p._id));
        assert.equal(await Like.countDocuments({}), 0);
        assert.equal(store.has('home:data'), false);
    });

    it('editing a podcast clears the home cache (previously only `save` did)', async () => {
        const p = await makePodcast();
        store.set('home:data', '{}');
        await podcastService.updatePodcastIntoDB(superAdmin, String(p._id), {
            title: 'x',
        });
        assert.equal(store.has('home:data'), false);
    });
});

// ---------------------------------------------------------------------------
describe('likes migration script', () => {
    const run = (...args: string[]) =>
        spawnSync(
            process.execPath,
            [
                '-r',
                'ts-node/register',
                path.join(__dirname, '../scripts/migrate-podcast-likes.ts'),
                ...args,
            ],
            {
                env: {
                    ...process.env,
                    DATABASE_URL: mongo.getUri(),
                    TS_NODE_TRANSPILE_ONLY: 'true',
                },
                encoding: 'utf8',
            }
        );

    it('copies embedded likes, fixes counters, removes the arrays, backfills mediaType — and is idempotent', async () => {
        const [u1, u2] = [oid(), oid()];
        const base = {
            category: categoryId,
            subCategory: subCategoryId,
            coverImage: 'x',
            title: 't',
            description: 'd',
            address: 'a',
            location: { type: 'Point', coordinates: [0, 0] },
            duration: 1,
        };
        const { insertedIds } = await raw('podcasts').insertMany([
            {
                ...base,
                podcast_url: 'https://cdn/podcast_videos/v.mp4',
                totalLikes: 7, // drifted counter
                likers: [
                    { user: u1, userType: 'NormalUser' },
                    { user: u2, userType: 'Creator' },
                    { user: u1, userType: 'NormalUser' }, // duplicate in old data
                ],
            },
            { ...base, totalLikes: 3, likers: [] }, // drifted, no likes
        ]);

        const dry = run('--dry-run');
        assert.equal(dry.status, 0, dry.stderr);
        assert.equal(
            await Like.countDocuments({}),
            0,
            'dry run writes nothing'
        );

        const first = run();
        assert.equal(first.status, 0, first.stderr);
        const second = run(); // idempotent
        assert.equal(second.status, 0, second.stderr);

        assert.equal(await Like.countDocuments({ podcast: insertedIds[0] }), 2);
        assert.equal((await Like.findOne({ user: u2 })).userType, 'Creator');
        const [a, b] = await Promise.all([
            raw('podcasts').findOne({ _id: insertedIds[0] }),
            raw('podcasts').findOne({ _id: insertedIds[1] }),
        ]);
        assert.equal(a.totalLikes, 2);
        assert.equal(b.totalLikes, 0);
        assert.equal('likers' in a, false);
        assert.equal(a.mediaType, 'video');
        assert.equal(b.mediaType, 'audio');
    });
});

// ---------------------------------------------------------------------------
describe('ownership: station vs creator', () => {
    const body = () => ({
        category: String(categoryId),
        subCategory: String(subCategoryId),
        coverImage: 'https://cdn/c.png',
        podcast_url: 'https://cdn/podcast_audio/a.mp3',
        title: 'Episode',
        description: 'd',
        location: { type: 'Point', coordinates: [3.38, 6.52] },
        address: 'Lagos',
        duration: 4.07,
    });
    const asCreator = () => ({ profileId: String(creatorId), role: 'creator' });

    it('a superAdmin upload always belongs to the station, whatever the request claims', async () => {
        const p = await podcastService.createPodcastIntoDB(superAdmin, {
            ...body(),
            station: String(oid()),
            creator: String(creatorId),
            totalView: 5000,
        });
        assert.equal(String(p.station), String(stationId));
        assert.equal(p.creator, null);
        assert.equal(p.totalView, 0);
    });

    it('the cover image is optional (episodes and clips can be published without one)', async () => {
        const validation =
            require('../app/modules/podcast/podcast.validation').default;
        const { coverImage, ...noCover } = body();
        assert.ok(coverImage);
        const episode = await podcastService.createPodcastIntoDB(superAdmin, noCover);
        assert.equal(episode.coverImage, undefined);
        assert.ok(
            validation.createPodcastValidationSchema.safeParse({ body: noCover }).success,
            'request validation accepts a missing cover'
        );
        const clip = await podcastService.createPodcastIntoDB(superAdmin, {
            ...noCover,
            type: 'clip',
            durationSeconds: 45,
        });
        assert.equal(clip.type, 'clip');
        // Deleting a podcast without a cover must not try to delete a cover file.
        await podcastService.deletePodcastFromDB(superAdmin, String(episode._id));
        assert.equal(await Podcast.countDocuments({ _id: episode._id }), 0);
    });

    it('a creator upload belongs to that creator, never to the station', async () => {
        await raw('creators').updateOne(
            { _id: creatorId },
            { $set: { isApproved: true } }
        );
        const p = await podcastService.createPodcastIntoDB(asCreator(), {
            ...body(),
            station: String(stationId),
        });
        assert.equal(String(p.creator), String(creatorId));
        assert.equal(p.station, null);
    });

    it('creators awaiting approval cannot publish', async () => {
        await raw('creators').updateOne(
            { _id: creatorId },
            { $set: { isApproved: false } }
        );
        await assert.rejects(
            podcastService.createPodcastIntoDB(asCreator(), body()),
            /waiting for approval/
        );
        assert.equal(await raw('podcasts').countDocuments(), 0);
    });

    it('fails clearly if the platform station does not exist', async () => {
        await raw('stations').deleteMany({});
        await assert.rejects(
            podcastService.createPodcastIntoDB(superAdmin, body()),
            /station is not set up/
        );
    });

    it('the model rejects a podcast with both owners or no owner', async () => {
        await assert.rejects(
            makePodcast({ creator: creatorId }),
            /either a creator or the station/
        );
        await assert.rejects(
            makePodcast({ station: null }),
            /either a creator or the station/
        );
    });

    it('"my podcasts" returns the creator\'s own podcasts to a creator', async () => {
        await makePodcast({ title: 'Mine', creator: creatorId, station: null });
        await makePodcast({ title: 'Station one' });
        const res = await podcastService.getMyPodcasts(asCreator(), {});
        assert.deepEqual(
            res.result.map((p: any) => p.title),
            ['Mine']
        );
    });

    it('"my podcasts" returns station podcasts (incl. legacy ownerless uploads) to a superAdmin', async () => {
        await makePodcast({ title: 'Station one' });
        await makePodcast({
            title: 'Creator one',
            creator: creatorId,
            station: null,
        });
        await raw('podcasts').insertOne({
            title: 'Legacy admin upload',
            creator: null,
            station: null,
            createdAt: new Date(),
        });
        const res = await podcastService.getMyPodcasts(superAdmin, {});
        assert.deepEqual(res.result.map((p: any) => p.title).sort(), [
            'Legacy admin upload',
            'Station one',
        ]);
    });

    it('station podcasts expose the station donation link as `donationLink`', async () => {
        await raw('stations').updateOne(
            { _id: stationId },
            { $set: { donationUrl: 'https://give.example' } }
        );
        const p = await makePodcast();
        const single = await podcastService.getSinglePodcast(
            String(p._id),
            null
        );
        assert.equal(single.station.donationLink, 'https://give.example');
        const mine = await podcastService.getMyPodcasts(superAdmin, {});
        assert.equal(
            mine.result[0].station.donationLink,
            'https://give.example'
        );
    });

    it('deleting or rejecting a creator removes their podcasts, likes, bookmarks and album entries', async () => {
        const CreatorService =
            require('../app/modules/creator/creator.service').default;
        const mine = await makePodcast({ creator: creatorId, station: null });
        const stationPodcast = await makePodcast();
        await podcastService.toggleLikePodcast(String(mine._id), listener());
        await raw('bookmarks').insertOne({ user: 'u1', podcast: mine._id });
        await raw('albums').insertOne({
            name: 'A',
            podcasts: [mine._id, stationPodcast._id],
        });

        await CreatorService.approveRejectCreator(String(creatorId), false);

        assert.equal(
            await raw('podcasts').countDocuments({ creator: creatorId }),
            0
        );
        assert.equal(
            await raw('podcasts').countDocuments({ _id: stationPodcast._id }),
            1,
            'station content untouched'
        );
        assert.equal(await Like.countDocuments({ podcast: mine._id }), 0);
        assert.equal(
            await raw('bookmarks').countDocuments({ podcast: mine._id }),
            0
        );
        assert.deepEqual(
            (await raw('albums').findOne({})).podcasts.map(String),
            [String(stationPodcast._id)]
        );
        assert.equal(
            await raw('creators').countDocuments({ _id: creatorId }),
            0
        );
    });
});

// ---------------------------------------------------------------------------
describe('clips (Preach Clips / reels)', () => {
    const validation =
        require('../app/modules/podcast/podcast.validation').default;
    const parse = (body: Record<string, unknown>) =>
        validation.createPodcastValidationSchema.safeParse({ body });
    const base = {
        category: '64b7f0f0f0f0f0f0f0f0f0f0',
        subCategory: '64b7f0f0f0f0f0f0f0f0f0f1',
        title: 't',
        description: 'd',
        duration: 1.3,
    };
    const makeClip = (overrides: Record<string, unknown> = {}) =>
        Podcast.create({
            type: 'clip',
            category: categoryId,
            subCategory: subCategoryId,
            coverImage: 'https://cdn/c.png',
            podcast_url: 'https://cdn/podcast_videos/clip.mp4',
            title: 'Clip',
            description: 'd',
            duration: 1.3,
            durationSeconds: 90,
            station: stationId,
            ...overrides,
        });

    it('request validation: episodes need a location, clips need durationSeconds ≤ 120', () => {
        const location = { type: 'Point', coordinates: [3.3, 6.5] };
        assert.equal(
            parse({ ...base, location, address: 'Lagos' }).success,
            true,
            'episode ok'
        );
        assert.equal(
            parse({ ...base }).success,
            false,
            'episode without location'
        );
        assert.equal(
            parse({ ...base, type: 'clip', durationSeconds: 90 }).success,
            true,
            'clip without location ok'
        );
        assert.equal(
            parse({ ...base, type: 'clip' }).success,
            false,
            'clip without durationSeconds'
        );
        const tooLong = parse({ ...base, type: 'clip', durationSeconds: 121 });
        assert.equal(tooLong.success, false);
        assert.match(JSON.stringify(tooLong.error.issues), /at most 2 minutes/);
        assert.equal(
            parse({
                ...base,
                location,
                address: 'x',
                sourcePodcast: '64b7f0f0f0f0f0f0f0f0f0f2',
            }).success,
            false,
            'only clips link to a source'
        );
    });

    it('the model enforces the 2-minute cap too, and stores clips without a location', async () => {
        const clip = await makeClip();
        assert.equal(clip.location, undefined);
        await assert.rejects(
            makeClip({ durationSeconds: 300 }),
            /at most 2 minutes/
        );
        await assert.rejects(
            makeClip({ durationSeconds: undefined }),
            /durationSeconds/
        );
    });

    it('a clip can link to its full episode; get-single returns it for "watch full message"', async () => {
        const episode = await makePodcast({ title: 'Full sermon' });
        const clip = await podcastService.createPodcastIntoDB(superAdmin, {
            type: 'clip',
            sourcePodcast: String(episode._id),
            category: String(categoryId),
            subCategory: String(subCategoryId),
            coverImage: 'https://cdn/c.png',
            podcast_url: 'https://cdn/podcast_videos/c.mp4',
            title: 'Highlight',
            description: 'd',
            duration: 1,
            durationSeconds: 60,
        });
        const single = await podcastService.getSinglePodcast(
            String(clip._id),
            null
        );
        assert.equal(single.sourcePodcast.title, 'Full sermon');
    });

    it('rejects a source that is missing or is itself a clip', async () => {
        const otherClip = await makeClip();
        const body = {
            type: 'clip',
            category: String(categoryId),
            subCategory: String(subCategoryId),
            coverImage: 'https://cdn/c.png',
            title: 'x',
            description: 'd',
            duration: 1,
            durationSeconds: 30,
        };
        await assert.rejects(
            podcastService.createPodcastIntoDB(superAdmin, {
                ...body,
                sourcePodcast: String(oid()),
            }),
            /Source podcast not found/
        );
        await assert.rejects(
            podcastService.createPodcastIntoDB(superAdmin, {
                ...body,
                sourcePodcast: String(otherClip._id),
            }),
            /only link to a full episode/
        );
    });

    it('type filters: typed records by type, untyped legacy records by the old duration rule', async () => {
        await makeClip({ title: 'Typed clip' });
        await makePodcast({ title: 'Typed episode', duration: 0.5 }); // short but explicitly an episode
        const legacy = {
            category: categoryId,
            subCategory: subCategoryId,
            coverImage: 'x',
            description: 'd',
            createdAt: new Date(),
        };
        await raw('podcasts').insertMany([
            { ...legacy, title: 'Legacy short', duration: 30 },
            { ...legacy, title: 'Legacy long', duration: 95 },
        ]);
        const titles = async (q: Record<string, unknown>) =>
            (await podcastService.getAllPodcasts(q)).result
                .map((r: any) => r.title)
                .sort();

        assert.deepEqual(await titles({ type: 'clip' }), [
            'Legacy short',
            'Typed clip',
        ]);
        assert.deepEqual(
            await titles({ reels: '1' }),
            ['Legacy short', 'Typed clip'],
            'old ?reels=1 still works'
        );
        assert.deepEqual(await titles({ type: 'episode' }), [
            'Legacy long',
            'Typed episode',
        ]);
        assert.equal(
            (await titles({})).length,
            4,
            'no type filter returns everything, as before'
        );
    });

    it('updating the type re-checks the rules against the whole record', async () => {
        const episode = await makePodcast();
        await assert.rejects(
            podcastService.updatePodcastIntoDB(
                superAdmin,
                String(episode._id),
                { type: 'clip' }
            ),
            /durationSeconds/
        );
        const asClip = await podcastService.updatePodcastIntoDB(
            superAdmin,
            String(episode._id),
            {
                type: 'clip',
                durationSeconds: 100,
            }
        );
        assert.equal(asClip.type, 'clip');

        const clip = await makeClip({ sourcePodcast: episode._id });
        await assert.rejects(
            podcastService.updatePodcastIntoDB(superAdmin, String(clip._id), {
                type: 'episode',
            }),
            /Location is required/
        );
        const promoted = await podcastService.updatePodcastIntoDB(
            superAdmin,
            String(clip._id),
            {
                type: 'episode',
                location: { type: 'Point', coordinates: [1, 2] },
                address: 'Abuja',
            } as any
        );
        assert.equal(promoted.type, 'episode');
        assert.equal(
            promoted.sourcePodcast,
            null,
            'episodes drop the source link'
        );
    });

    it('"my podcasts" keeps the ownership filter when searching (regression)', async () => {
        await makeClip({ title: 'Grace clip (station)' });
        await makeClip({
            title: 'Grace clip (creator)',
            creator: creatorId,
            station: null,
        });
        const res = await podcastService.getMyPodcasts(superAdmin, {
            searchTerm: 'Grace',
            type: 'clip',
        });
        assert.deepEqual(
            res.result.map((p: any) => p.title),
            ['Grace clip (station)']
        );
    });
});

// ---------------------------------------------------------------------------
describe('indexes', () => {
    const usesIndex = (plan: any): boolean =>
        JSON.stringify(plan).includes('"IXSCAN"');
    const winning = async (query: any) =>
        (await query.explain('queryPlanner')).queryPlanner.winningPlan;

    it('hot queries are served by an index, not a collection scan', async () => {
        await Promise.all([
            makePodcast(),
            makePodcast({ creator: creatorId, station: null }),
        ]);
        const user = oid();
        assert.ok(
            usesIndex(await winning(Like.find({ user }))),
            'feed: liked podcasts by user'
        );
        assert.ok(
            usesIndex(await winning(Like.find({ podcast: oid(), user }))),
            'like lookup'
        );
        assert.ok(
            usesIndex(
                await winning(
                    Podcast.find({ creator: creatorId }).sort({ createdAt: -1 })
                )
            ),
            'creator podcasts'
        );
        assert.ok(
            usesIndex(
                await winning(
                    Podcast.find({ station: stationId }).sort({ createdAt: -1 })
                )
            ),
            'station podcasts'
        );
        assert.ok(
            usesIndex(await winning(Podcast.find({ duration: { $lte: 60 } }))),
            'reels'
        );
        assert.ok(
            usesIndex(
                await winning(Podcast.find().sort({ totalView: -1 }).limit(10))
            ),
            'popular'
        );
    });
});

// ---------------------------------------------------------------------------
describe('query sanitising', () => {
    it('escapes regex input and strips operator filters', () => {
        assert.equal(
            new RegExp(escapeRegex('(a+)+$'), 'i').test('x(a+)+$y'),
            true
        );
        assert.equal(new RegExp(escapeRegex('a.c'), 'i').test('abc'), false);
        assert.equal(escapeRegex(undefined), '');
        assert.deepEqual(
            sanitizeFilter({
                isApproved: 'true',
                email: { $ne: 'x' },
                $where: '1',
                'a.b': 1,
                category: 'id1',
            }),
            { isApproved: 'true', category: 'id1' }
        );
    });
});
