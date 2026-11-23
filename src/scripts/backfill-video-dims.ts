/* eslint-disable no-console */
/**
 * Backfill: stores videoWidth / videoHeight (display size, rotation applied) for
 * video podcasts that don't have them, by reading each file's MP4 header — a few
 * KB per video over HTTP Range, no conversion, no AWS cost beyond CDN bytes.
 *
 *   npm run media:dims -- --dry-run          # print the sizes it would store
 *   npm run media:dims                       # all video podcasts missing a size
 *   npm run media:dims -- --type=clip        # only Preach Clips
 *   node dist/scripts/backfill-video-dims.js # on the server, after `npm run build`
 *
 * Safe to re-run: only podcasts with no size are touched.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import config from '../app/config';
import { probeVideoDimensions } from '../app/modules/media/media.probe';
import { detectMediaType } from '../app/modules/podcast/podcast.model';
import Podcast from '../app/modules/podcast/podcast.model';
import { clipFilter, episodeFilter } from '../app/modules/podcast/podcast.constant';
import redis from '../app/utilities/redisClient';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TYPE = args.find((a) => a.startsWith('--type='))?.split('=')[1];
const CONCURRENCY = 4;

async function main() {
    if (TYPE && !['episode', 'clip'].includes(TYPE)) throw new Error('--type must be "episode" or "clip"');
    await mongoose.connect(config.database_url as string);

    const filter: Record<string, unknown> = {
        videoWidth: null,
        podcast_url: { $exists: true, $nin: [null, ''] },
        // Legacy documents have no mediaType; their file name decides below.
        mediaType: { $ne: 'audio' },
        ...(TYPE === 'clip' ? clipFilter() : TYPE === 'episode' ? episodeFilter() : {}),
    };
    const podcasts = await Podcast.find(filter)
        .setOptions({ includeHidden: true })
        .select('title podcast_url mediaType')
        .sort({ createdAt: -1 })
        .lean();
    const videos = podcasts.filter((p) => (p.mediaType ?? detectMediaType(p.podcast_url)) === 'video');
    console.log(`${videos.length} video podcast(s) without a size${DRY_RUN ? ' [dry-run]' : ''}`);

    let saved = 0;
    let unknown = 0;
    for (let i = 0; i < videos.length; i += CONCURRENCY) {
        await Promise.all(
            videos.slice(i, i + CONCURRENCY).map(async (p) => {
                const dims = await probeVideoDimensions(p.podcast_url);
                const label = `${p._id} ${String(p.title).slice(0, 40)}`;
                if (!dims) {
                    unknown++;
                    console.log(`  ?  ${label} — size not readable (not MP4/MOV, or unreachable)`);
                    return;
                }
                const shape = dims.height > dims.width ? 'portrait' : dims.width > dims.height ? 'landscape' : 'square';
                console.log(`  ✓  ${label} — ${dims.width}×${dims.height} ${shape}`);
                if (DRY_RUN) return;
                const res = await Podcast.updateOne(
                    { _id: p._id, videoWidth: null, podcast_url: p.podcast_url },
                    { $set: { videoWidth: dims.width, videoHeight: dims.height } }
                ).setOptions({ includeHidden: true });
                saved += res.modifiedCount;
            })
        );
    }
    console.log(`Done: ${DRY_RUN ? 0 : saved} saved, ${unknown} unreadable.`);
    if (!DRY_RUN && saved) {
        // Cached home / list responses would otherwise keep serving the old shape for a while.
        const keys = await redis.keys('home:*');
        if (keys.length) await redis.del(...keys);
    }
}

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => undefined);
        redis.disconnect();
    });
