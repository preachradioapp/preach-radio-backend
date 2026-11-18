/* eslint-disable no-console */
/**
 * One-time migration: embedded `Podcast.likers` array  ->  `likes` collection.
 *
 *   npm run migrate:likes -- --dry-run     # report only, writes nothing
 *   npm run migrate:likes                  # migrate (ts-node, from source)
 *   node dist/scripts/migrate-podcast-likes.js   # on the server, after `npm run build`
 *
 * Safe to re-run (idempotent):
 *   1. copies every embedded like into `likes` (upsert on the unique {podcast,user} index)
 *   2. recomputes `totalLikes` for every podcast from the `likes` collection
 *   3. removes the legacy `likers` arrays — only after step 1 succeeded for all podcasts
 *   4. backfills `mediaType` (audio/video) where missing
 *
 * Uses the raw collections (not the Podcast model) so it does not need Redis and
 * is not affected by the model's visibility hooks.
 */
import 'dotenv/config';
import type { AnyBulkWriteOperation } from 'mongodb';
import mongoose, { Types } from 'mongoose';
import config from '../app/config';
import Like, { ILike } from '../app/modules/like/like.model';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = 500;
const VIDEO_URL = /podcast_video|\.(mp4|mov|webm|m4v|m3u8)(\?|$)/i;

type LegacyLiker = { user?: Types.ObjectId; userType?: string };
type RawPodcast = {
    _id: Types.ObjectId;
    likers?: LegacyLiker[];
    podcast_url?: string;
    createdAt?: Date;
};

const log = (msg: string) =>
    console.log(`${DRY_RUN ? '[dry-run] ' : ''}${msg}`);

async function copyLegacyLikes() {
    const podcasts = mongoose.connection.collection<RawPodcast>('podcasts');
    const cursor = podcasts.find(
        { 'likers.0': { $exists: true } },
        { projection: { likers: 1, createdAt: 1 } }
    );

    let podcastCount = 0;
    let likeCount = 0;
    let skipped = 0;
    let ops: AnyBulkWriteOperation<ILike>[] = [];

    const flush = async () => {
        if (!ops.length) return;
        // Raw collection on purpose: the model's automatic timestamps would add a
        // `$set: { updatedAt }` that conflicts with the `$setOnInsert` below.
        if (!DRY_RUN) {
            await mongoose.connection
                .collection<ILike>(Like.collection.collectionName)
                .bulkWrite(ops, { ordered: false });
        }
        ops = [];
    };

    for await (const p of cursor) {
        podcastCount += 1;
        const seen = new Set<string>();
        for (const liker of p.likers ?? []) {
            const userType =
                liker.userType === 'Creator' ? 'Creator' : 'NormalUser';
            if (!liker.user || seen.has(String(liker.user))) {
                skipped += 1; // malformed or duplicate entry in the old array
                continue;
            }
            seen.add(String(liker.user));
            likeCount += 1;
            ops.push({
                updateOne: {
                    filter: { podcast: p._id, user: liker.user },
                    update: {
                        $setOnInsert: {
                            podcast: p._id,
                            user: liker.user,
                            userType,
                            // Original like time is unknown; the podcast's creation
                            // date is the safest lower bound for ordering.
                            createdAt: p.createdAt ?? new Date(),
                            updatedAt: new Date(),
                        },
                    },
                    upsert: true,
                },
            });
            if (ops.length >= BATCH) await flush();
        }
    }
    await flush();
    log(
        `Step 1: ${likeCount} likes from ${podcastCount} podcasts copied` +
            (skipped ? ` (${skipped} duplicate/malformed entries skipped)` : '')
    );
}

async function recomputeCounters() {
    const podcasts = mongoose.connection.collection<RawPodcast>('podcasts');
    const counts = await Like.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $group: { _id: '$podcast', n: { $sum: 1 } } },
    ]);

    let ops: AnyBulkWriteOperation<RawPodcast>[] = [];
    let changed = 0;
    for (const { _id, n } of counts) {
        ops.push({
            updateOne: {
                filter: { _id, totalLikes: { $ne: n } } as never,
                update: { $set: { totalLikes: n } } as never,
            },
        });
        if (ops.length >= BATCH) {
            if (!DRY_RUN)
                changed += (await podcasts.bulkWrite(ops)).modifiedCount;
            ops = [];
        }
    }
    if (ops.length && !DRY_RUN)
        changed += (await podcasts.bulkWrite(ops)).modifiedCount;

    // Podcasts with no likes at all must show 0.
    const liked = counts.map((c) => c._id);
    const zeroFilter = {
        _id: { $nin: liked },
        totalLikes: { $nin: [0, null] },
    };
    const zeroed = DRY_RUN
        ? await podcasts.countDocuments(zeroFilter as never)
        : (
              await podcasts.updateMany(
                  zeroFilter as never,
                  { $set: { totalLikes: 0 } } as never
              )
          ).modifiedCount;

    log(
        `Step 2: totalLikes recomputed for ${counts.length} liked podcasts` +
            (DRY_RUN ? '' : ` (${changed} corrected, ${zeroed} reset to 0)`)
    );
}

async function removeLegacyArrays() {
    const podcasts = mongoose.connection.collection('podcasts');
    const filter = { likers: { $exists: true } };
    const n = DRY_RUN
        ? await podcasts.countDocuments(filter)
        : (await podcasts.updateMany(filter, { $unset: { likers: '' } }))
              .modifiedCount;
    log(`Step 3: legacy likers array removed from ${n} podcasts`);
}

async function backfillMediaType() {
    const podcasts = mongoose.connection.collection<RawPodcast>('podcasts');
    const cursor = podcasts.find({ mediaType: { $exists: false } } as never, {
        projection: { podcast_url: 1 },
    });
    let video = 0;
    let audio = 0;
    let ops: AnyBulkWriteOperation<RawPodcast>[] = [];
    for await (const p of cursor) {
        const mediaType =
            p.podcast_url && VIDEO_URL.test(p.podcast_url) ? 'video' : 'audio';
        if (mediaType === 'video') video += 1;
        else audio += 1;
        ops.push({
            updateOne: {
                filter: { _id: p._id },
                update: { $set: { mediaType } } as never,
            },
        });
        if (ops.length >= BATCH) {
            if (!DRY_RUN) await podcasts.bulkWrite(ops);
            ops = [];
        }
    }
    if (ops.length && !DRY_RUN) await podcasts.bulkWrite(ops);
    log(
        `Step 4: mediaType set on ${
            audio + video
        } podcasts (${video} video, ${audio} audio)`
    );
}

async function main() {
    if (!config.database_url) throw new Error('DATABASE_URL is not set');
    await mongoose.connect(config.database_url);
    log(`Connected to ${mongoose.connection.name}`);

    // The unique index must exist before upserting, or concurrent runs could duplicate.
    if (!DRY_RUN) await Like.init();

    await copyLegacyLikes();
    await recomputeCounters();
    await removeLegacyArrays();
    await backfillMediaType();

    log('Done.');
}

main()
    .catch((err) => {
        console.error(
            'Migration failed — nothing after the failing step was applied:',
            err
        );
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
