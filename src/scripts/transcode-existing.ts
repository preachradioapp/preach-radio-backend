/* eslint-disable no-console */
/**
 * Backfill: converts podcasts uploaded before HLS conversion existed.
 *
 *   npm run media:backfill -- --dry-run                 # list what would be converted
 *   npm run media:backfill -- --limit=20                # convert the 20 newest
 *   npm run media:backfill -- --type=clip --limit=100   # only Preach Clips
 *   npm run media:backfill -- --include-failed          # also retry failed ones
 *   node dist/scripts/transcode-existing.js --limit=20  # on the server, after `npm run build`
 *
 * Needs the same environment as the API (MongoDB, Redis, AWS keys, and
 * TRANSCODE_ENABLED=true, MEDIACONVERT_ROLE_ARN). Each podcast is converted once:
 * re-running only picks up podcasts that have no conversion yet. Jobs are started
 * one by one; MediaConvert queues them, and the webhook finishes each podcast.
 *
 * Cost: every minute of video is billed per rendition (2 for video, 1 for audio).
 * Start with a small --limit and check the results in the dashboard.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import config from '../app/config';
import { mediaConfig } from '../app/modules/media/media.config';
import { s3KeyFromUrl, startTranscode } from '../app/modules/media/media.service';
import Podcast from '../app/modules/podcast/podcast.model';
import redis from '../app/utilities/redisClient';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const DRY_RUN = flag('dry-run');
const INCLUDE_FAILED = flag('include-failed');
const LIMIT = Math.max(1, Number(option('limit') ?? 50) || 50);
const TYPE = option('type');

const log = (msg: string) => console.log(`${DRY_RUN ? '[dry-run] ' : ''}${msg}`);

async function main() {
    if (TYPE && !['episode', 'clip'].includes(TYPE)) {
        throw new Error('--type must be "episode" or "clip"');
    }
    const cfg = mediaConfig();
    if (!DRY_RUN && (!cfg.enabled || !cfg.roleArn)) {
        throw new Error(
            'Set TRANSCODE_ENABLED=true and MEDIACONVERT_ROLE_ARN before converting (or use --dry-run).'
        );
    }

    await mongoose.connect(config.database_url as string);

    const filter: Record<string, unknown> = {
        podcast_url: { $nin: [null, ''] },
        $or: [
            { processing: { $exists: false } },
            { processing: null },
            ...(INCLUDE_FAILED ? [{ 'processing.status': 'failed' }] : []),
        ],
        ...(TYPE === 'clip'
            ? { type: 'clip' }
            : TYPE === 'episode'
              ? { type: { $ne: 'clip' } }
              : {}),
    };

    const total = await Podcast.countDocuments(filter).setOptions({ includeHidden: true });
    const podcasts = await Podcast.find(filter)
        .setOptions({ includeHidden: true })
        .sort({ createdAt: -1 })
        .limit(LIMIT)
        .select('title podcast_url mediaType durationSeconds')
        .lean();

    log(`${total} podcast(s) need conversion; handling ${podcasts.length} (newest first).`);

    let started = 0;
    let skipped = 0;
    let failed = 0;
    let minutes = 0;
    for (const p of podcasts) {
        const label = `${p._id} "${p.title}" (${p.mediaType ?? 'audio'})`;
        if (!s3KeyFromUrl(p.podcast_url)) {
            skipped += 1;
            log(`skip   ${label}: not in the app bucket`);
            continue;
        }
        minutes += (p.durationSeconds ?? 0) / 60;
        if (DRY_RUN) {
            log(`would convert ${label}`);
            continue;
        }
        const updated = await startTranscode(String(p._id), { reset: true });
        const status = updated?.processing?.status;
        if (status === 'processing') {
            started += 1;
            log(`start  ${label}: job ${updated?.processing?.jobId}`);
        } else {
            failed += 1;
            log(`FAILED ${label}: ${status} — ${updated?.processing?.error ?? 'unknown error'}`);
        }
    }

    log(
        `Done. started=${started} skipped=${skipped} failed=${failed}` +
            (minutes ? `; about ${Math.round(minutes)} min of media (known durations only)` : '')
    );
}

main()
    .catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => undefined);
        redis.disconnect();
    });
