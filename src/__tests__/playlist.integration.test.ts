/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
/**
 * Integration tests for playlists (ownership, mass assignment, atomic add/remove)
 * against an in-memory MongoDB.   npm test
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Podcast model hooks import Redis.
const fakeRedis: any = {
    on: () => fakeRedis,
    get: async () => null,
    set: async () => 'OK',
    del: async () => 0,
    unlink: async () => 0,
    keys: async () => [],
    scanStream: () =>
        (async function* () {
            yield [];
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
const PodcastPlaylist = require('../app/modules/playlist/playlist.model').default;
// get-single populates the owner (refPath) and each podcast's refs → register those models.
require('../app/modules/normalUser/normalUser.model');
require('../app/modules/creator/creator.model');
require('../app/modules/category/category.model');
require('../app/modules/subCategory/subCategory.model');
require('../app/modules/station/station.model');
const playlists = require('../app/modules/playlist/playlist.service').default;
const { PLAYLIST_MAX_PODCASTS } = require('../app/modules/playlist/playlist.service');

const oid = () => new mongoose.Types.ObjectId();
const raw = (name: string) => mongoose.connection.collection(name);

let mongo: any;
let alice: string;
let bob: string;
let creator: string;
let podcastIds: string[];

const makePodcast = (title: string) =>
    Podcast.create({
        station: oid(),
        category: oid(),
        subCategory: oid(),
        podcast_url: 'https://cdn/podcast_audio/a.mp3',
        title,
        description: 'd',
        location: { type: 'Point', coordinates: [0, 0] },
        address: 'Lagos',
        duration: 4,
    });

const newPlaylist = (owner = alice, role = 'user', extra: Record<string, unknown> = {}) =>
    playlists.createPlaylist(owner, role, {
        name: 'Morning',
        description: 'd',
        cover_image: 'https://cdn/c.png',
        podcasts: [podcastIds[0]],
        ...extra,
    });

before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([Podcast.init(), PodcastPlaylist.init()]);
});

after(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});

beforeEach(async () => {
    await Promise.all(['podcasts', 'podcastplaylists'].map((c) => raw(c).deleteMany({})));
    alice = String(oid());
    bob = String(oid());
    creator = String(oid());
    podcastIds = [];
    for (const t of ['A', 'B', 'C']) podcastIds.push(String((await makePodcast(t))._id));
});

const ids = (pl: any) => pl.podcasts.map((p: any) => String(p));

describe('ownership', () => {
    it('sets user and userType from the signed-in account, ignoring what the client sends', async () => {
        const pl = await newPlaylist(alice, 'user', { user: bob, userType: 'Creator' });
        assert.equal(String(pl.user), alice);
        assert.equal(pl.userType, 'NormalUser');
        const mine = await newPlaylist(creator, 'creator');
        assert.equal(mine.userType, 'Creator');
    });

    it('admins cannot own playlists', async () => {
        await assert.rejects(newPlaylist(alice, 'superAdmin'), /Only listeners and creators/);
    });

    it('update cannot move a playlist to another user (mass assignment)', async () => {
        const pl = await newPlaylist();
        const updated = await playlists.updatePlaylist(alice, String(pl._id), { name: 'Evening', user: bob, userType: 'Creator', _id: String(oid()) });
        assert.equal(updated.name, 'Evening');
        assert.equal(String(updated.user), alice);
        assert.equal(updated.userType, 'NormalUser');
        assert.equal(String(updated._id), String(pl._id));
    });

    it("another user cannot update, add to or remove from someone's playlist", async () => {
        const pl = await newPlaylist();
        const id = String(pl._id);
        await assert.rejects(playlists.updatePlaylist(bob, id, { name: 'x' }), /not found/);
        await assert.rejects(playlists.addPodcastToPlaylist(bob, id, podcastIds[1]), /not found/);
        await assert.rejects(playlists.removePodcastFromPlaylist(bob, id, podcastIds[0]), /not found/);
        assert.deepEqual(ids(await PodcastPlaylist.findById(id)), [podcastIds[0]]);
    });

    it('de-duplicates podcast ids on create and update', async () => {
        const pl = await newPlaylist(alice, 'user', { podcasts: [podcastIds[0], podcastIds[1], podcastIds[0]] });
        assert.deepEqual(ids(pl), [podcastIds[0], podcastIds[1]]);
        const up = await playlists.updatePlaylist(alice, String(pl._id), { podcasts: [podcastIds[2], podcastIds[2]] });
        assert.deepEqual(ids(up), [podcastIds[2]]);
    });
});

describe('add / remove one podcast', () => {
    it('adds without duplicates and removes', async () => {
        const pl = await newPlaylist();
        const id = String(pl._id);
        await playlists.addPodcastToPlaylist(alice, id, podcastIds[1]);
        const again = await playlists.addPodcastToPlaylist(alice, id, podcastIds[1]);
        assert.deepEqual(ids(again), [podcastIds[0], podcastIds[1]]);
        const removed = await playlists.removePodcastFromPlaylist(alice, id, podcastIds[0]);
        assert.deepEqual(ids(removed), [podcastIds[1]]);
        // Removing something that isn't there is a no-op, not an error.
        const noop = await playlists.removePodcastFromPlaylist(alice, id, podcastIds[2]);
        assert.deepEqual(ids(noop), [podcastIds[1]]);
    });

    it('concurrent adds from two devices are all kept', async () => {
        const pl = await newPlaylist();
        const id = String(pl._id);
        await Promise.all([playlists.addPodcastToPlaylist(alice, id, podcastIds[1]), playlists.addPodcastToPlaylist(alice, id, podcastIds[2])]);
        assert.deepEqual(ids(await PodcastPlaylist.findById(id)).sort(), [...podcastIds].sort());
    });

    it('rejects unknown podcasts', async () => {
        const pl = await newPlaylist();
        await assert.rejects(playlists.addPodcastToPlaylist(alice, String(pl._id), String(oid())), /Podcast not found/);
    });

    it('enforces the size cap', async () => {
        const pl = await newPlaylist();
        const full = Array.from({ length: PLAYLIST_MAX_PODCASTS }, () => oid());
        await raw('podcastplaylists').updateOne({ _id: pl._id }, { $set: { podcasts: full } });
        await assert.rejects(playlists.addPodcastToPlaylist(alice, String(pl._id), podcastIds[1]), /at most/);
    });
});

describe('indexes', () => {
    it('has the user + updatedAt index for "my playlists"', async () => {
        const indexes = await raw('podcastplaylists').indexes();
        assert.ok(indexes.some((i: any) => i.key.user === 1 && i.key.updatedAt === -1));
    });
});

describe('optional cover, empty playlists, privacy and cleanup', () => {
    it('creates an empty playlist without a cover or description', async () => {
        const pl = await playlists.createPlaylist(alice, 'user', { name: 'New playlist' });
        assert.deepEqual(ids(pl), []);
        assert.equal(pl.cover_image, null);
        assert.equal(pl.description, '');
        assert.equal(pl.isPublic, false);
        const added = await playlists.addPodcastToPlaylist(alice, String(pl._id), podcastIds[0]);
        assert.deepEqual(ids(added), [podcastIds[0]]);
    });

    it('a private playlist opens only for its owner and admins (404 for others)', async () => {
        const pl = await newPlaylist();
        const id = String(pl._id);
        assert.equal((await playlists.getPlaylistById(id, { profileId: alice, role: 'user' })).name, 'Morning');
        assert.ok(await playlists.getPlaylistById(id, { profileId: String(oid()), role: 'admin' }));
        await assert.rejects(playlists.getPlaylistById(id, { profileId: bob, role: 'user' }), /not found/);
        await playlists.updatePlaylist(alice, id, { isPublic: true });
        assert.ok(await playlists.getPlaylistById(id, { profileId: bob, role: 'user' }));
    });

    it('the list shows only public playlists to users (a query param cannot widen it), all to admins', async () => {
        await newPlaylist(alice, 'user', { name: 'Private' });
        await newPlaylist(bob, 'user', { name: 'Shared', isPublic: true });
        const forUser = await playlists.getAllPlaylists({ isPublic: 'false' }, { profileId: alice, role: 'user' });
        assert.deepEqual(
            forUser.result.map((p: any) => p.name),
            ['Shared']
        );
        const forAdmin = await playlists.getAllPlaylists({}, { profileId: String(oid()), role: 'superAdmin' });
        assert.equal(forAdmin.meta.total, 2);
    });

    it('deleted podcasts are pulled from every playlist (string or ObjectId ids)', async () => {
        const a = await newPlaylist(alice, 'user', { podcasts: [podcastIds[0], podcastIds[1]] });
        const b = await newPlaylist(bob, 'user', { podcasts: [podcastIds[1], podcastIds[2]] });
        await playlists.pullPodcastsFromPlaylists([podcastIds[1]]);
        await playlists.pullPodcastsFromPlaylists([new mongoose.Types.ObjectId(podcastIds[2])]);
        assert.deepEqual(ids(await PodcastPlaylist.findById(a._id)), [podcastIds[0]]);
        assert.deepEqual(ids(await PodcastPlaylist.findById(b._id)), []);
    });

    it("deleting an account deletes that user's playlists only", async () => {
        await newPlaylist(alice);
        await newPlaylist(alice, 'user', { name: 'Second' });
        await newPlaylist(bob);
        assert.equal(await playlists.deletePlaylistsOfUser(alice), 2);
        assert.equal(await PodcastPlaylist.countDocuments({ user: alice }), 0);
        assert.equal(await PodcastPlaylist.countDocuments({ user: bob }), 1);
    });

    it('the schema itself rejects more than the cap', async () => {
        const tooMany = Array.from({ length: PLAYLIST_MAX_PODCASTS + 1 }, () => oid());
        await assert.rejects(PodcastPlaylist.create({ user: oid(), userType: 'NormalUser', name: 'x', podcasts: tooMany }), /at most/);
    });

    it('has the podcasts index used by the cleanup', async () => {
        const indexes = await raw('podcastplaylists').indexes();
        assert.ok(indexes.some((i: any) => i.key.podcasts === 1));
    });
});
