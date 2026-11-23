/* eslint-disable @typescript-eslint/no-explicit-any */
import { CreateJobCommand, GetJobCommand } from '@aws-sdk/client-mediaconvert';
import httpStatus from 'http-status';
import mongoose from 'mongoose';
import AppError from '../../error/appError';
import { errorLogger, logger } from '../../shared/logger';
import redis from '../../utilities/redisClient';
import Podcast from '../podcast/podcast.model';
import { deleteS3Prefix, getMediaConvert } from './media.aws';
import {
    JOB_APP_TAG,
    MAX_START_ATTEMPTS,
    MEDIA_ROOT,
    mediaConfig,
} from './media.config';
import {
    buildCreateJobRequest,
    orientationOf,
    outputLayout,
    renditionsFor,
} from './media.jobSettings';

const ADMIN = { includeHidden: true } as const;
const MINUTE = 60_000;
/** A running job we haven't heard about for this long is checked with GetJob. */
const CHECK_AFTER_MS = 10 * MINUTE;
/** A job still running after this long is given up on. */
const GIVE_UP_AFTER_MS = 6 * 60 * MINUTE;
/** Wait before retrying a job that failed to start. */
const RETRY_AFTER_MS = 2 * MINUTE;
const SWEEP_EVERY_MS = 5 * MINUTE;
const SWEEP_LOCK_KEY = 'lock:media-sweeper';

// ---------------------------------------------------------------------------
// URL <-> S3 key
// ---------------------------------------------------------------------------

/** S3 key of a file in the app bucket (CloudFront or S3 URL); null for anything else. */
export const s3KeyFromUrl = (url?: string | null): string | null => {
    if (!url) return null;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    const { bucket, cdnBase, region } = mediaConfig();
    const hosts = [
        new URL(cdnBase).host,
        `${bucket}.s3.${region}.amazonaws.com`,
        `${bucket}.s3.amazonaws.com`,
    ];
    if (!hosts.includes(parsed.host)) return null;
    const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    return key || null;
};

export const cdnUrl = (key: string) =>
    `${mediaConfig().cdnBase}/${key.split('/').map(encodeURIComponent).join('/')}`;

const keyFromS3Uri = (uri?: string | null) => {
    const match = /^s3:\/\/[^/]+\/(.+)$/.exec(uri ?? '');
    return match ? match[1] : null;
};

/** media/<podcastId>/<runId>/ of an hlsUrl we produced, or null. */
const runIdOfHlsUrl = (podcastId: string, hlsUrl?: string | null) => {
    const key = s3KeyFromUrl(hlsUrl);
    const parts = key?.split('/') ?? [];
    return parts[0] === MEDIA_ROOT && parts[1] === podcastId ? parts[2] : null;
};

const newRunId = () =>
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Best-effort file cleanup: never blocks or fails the caller. */
const cleanup = (prefix: string) => {
    deleteS3Prefix(prefix).catch((err) =>
        errorLogger.error(`Media cleanup failed for ${prefix}:`, err)
    );
};

/** Removes every converted file of a podcast (call after the podcast is deleted). */
export const deleteMediaFolder = (podcastId: string) => {
    if (!mongoose.isValidObjectId(podcastId)) return;
    cleanup(`${MEDIA_ROOT}/${podcastId}/`);
};

const setProcessing = (
    podcastId: string,
    processing: Record<string, unknown>
) =>
    Podcast.findOneAndUpdate(
        { _id: podcastId },
        { $set: { processing } },
        { ...ADMIN, new: true }
    );

// ---------------------------------------------------------------------------
// Starting a job
// ---------------------------------------------------------------------------

/** Errors that will fail the same way on every retry. */
const isPermanentError = (err: any) =>
    [
        'BadRequestException',
        'ForbiddenException',
        'NotFoundException',
        'AccessDeniedException',
        'ConfigurationError',
    ].includes(err?.name);

const errorText = (err: any) =>
    String(err?.message || err || 'Unknown error').slice(0, 500);

/**
 * Starts converting a podcast's media file. Never throws: a failure is recorded
 * on the podcast (`processing.status` queued → retried by the sweeper, or failed),
 * and the original `podcast_url` keeps playing either way.
 *
 * `reset` = a new media file (or an admin re-run): the attempt counter restarts.
 * Returns the updated podcast, or null when conversion is off / nothing changed.
 */
export const startTranscode = async (
    podcastId: string,
    { reset = false }: { reset?: boolean } = {}
) => {
    const cfg = mediaConfig();
    if (!cfg.enabled) return null;

    const podcast = await Podcast.findById(podcastId)
        .setOptions(ADMIN)
        .select('podcast_url mediaType type videoWidth videoHeight processing')
        .lean();
    if (!podcast) return null;

    const now = new Date();
    const attempts = reset ? 0 : podcast.processing?.attempts ?? 0;
    const inputKey = s3KeyFromUrl(podcast.podcast_url);
    if (!inputKey) {
        return setProcessing(podcastId, {
            status: 'skipped',
            error: 'The media file is not stored in the app bucket',
            attempts,
            updatedAt: now,
        });
    }

    const runId = newRunId();
    try {
        if (!cfg.roleArn) {
            const err = new Error('MEDIACONVERT_ROLE_ARN is not set');
            err.name = 'ConfigurationError';
            throw err;
        }
        const request = buildCreateJobRequest({
            bucket: cfg.bucket,
            inputKey,
            podcastId,
            runId,
            mediaType: podcast.mediaType === 'video' ? 'video' : 'audio',
            orientation: orientationOf(podcast),
            renditions: renditionsFor(podcast),
            roleArn: cfg.roleArn,
            queueArn: cfg.queueArn,
        });
        const response = await getMediaConvert().send(
            new CreateJobCommand(request)
        );
        const jobId = response?.Job?.Id;
        if (!jobId) throw new Error('MediaConvert returned no job id');

        logger.info(`MediaConvert job ${jobId} started for podcast ${podcastId}`);
        return setProcessing(podcastId, {
            status: 'processing',
            jobId,
            runId,
            error: null,
            attempts: attempts + 1,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
        });
    } catch (err) {
        const nextAttempts = attempts + 1;
        const status =
            isPermanentError(err) || nextAttempts >= MAX_START_ATTEMPTS
                ? 'failed'
                : 'queued';
        errorLogger.error(
            `Could not start MediaConvert for podcast ${podcastId} (attempt ${nextAttempts}, now ${status}):`,
            err
        );
        return setProcessing(podcastId, {
            status,
            jobId: null,
            runId: null,
            error: errorText(err),
            attempts: nextAttempts,
            startedAt: null,
            completedAt: null,
            updatedAt: now,
        });
    }
};

/** Admin "retry / re-convert". Keeps the current hlsUrl playing until the new run is ready. */
export const reprocessPodcast = async (podcastId: string) => {
    if (!mediaConfig().enabled) {
        throw new AppError(
            httpStatus.CONFLICT,
            'Media conversion is turned off on the server (TRANSCODE_ENABLED)'
        );
    }
    const podcast = await Podcast.findById(podcastId)
        .setOptions(ADMIN)
        .select('podcast_url')
        .lean();
    if (!podcast) throw new AppError(httpStatus.NOT_FOUND, 'Podcast not found');
    if (!s3KeyFromUrl(podcast.podcast_url)) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'This podcast’s media file is not stored in the app bucket, so it can’t be converted'
        );
    }
    return startTranscode(podcastId, { reset: true });
};

// ---------------------------------------------------------------------------
// Finishing a job (webhook and sweeper share this)
// ---------------------------------------------------------------------------

export type JobResult = {
    podcastId: string;
    jobId: string;
    runId?: string | null;
    status: 'COMPLETE' | 'ERROR' | 'CANCELED';
    durationMs?: number | null;
    /** Largest rendition's size, from MediaConvert. */
    dims?: { width: number; height: number } | null;
    hlsKey?: string | null;
    posterKey?: string | null;
    errorMessage?: string | null;
};

export type JobOutcome =
    | 'ready'
    | 'failed'
    | 'duplicate'
    | 'stale'
    | 'deleted'
    | 'ignored';

/**
 * Applies a finished job to its podcast. Idempotent (EventBridge may deliver an
 * event more than once) and safe against races: only the podcast's CURRENT job
 * is applied; results of replaced or deleted media are cleaned up instead.
 */
export const applyJobResult = async (result: JobResult): Promise<JobOutcome> => {
    const { podcastId, jobId } = result;
    if (!mongoose.isValidObjectId(podcastId) || !jobId) return 'ignored';

    const podcast = await Podcast.findById(podcastId)
        .setOptions(ADMIN)
        .select(
            'processing hlsUrl coverImage mediaType durationSeconds videoWidth videoHeight'
        )
        .lean();

    if (!podcast) {
        // Deleted while converting: remove what the job wrote.
        deleteMediaFolder(podcastId);
        return 'deleted';
    }
    const current = podcast.processing;
    if (current?.jobId !== jobId) {
        // The media was replaced or re-run since; this run's files are unused.
        if (result.runId && result.runId !== current?.runId) {
            cleanup(outputLayout(podcastId, result.runId).prefix);
        }
        return 'stale';
    }
    // Already applied. A late COMPLETE may still replace a timeout "failed".
    if (
        current.status === 'ready' ||
        (current.status === 'failed' && result.status !== 'COMPLETE')
    ) {
        return 'duplicate';
    }

    const now = new Date();
    const filter = { _id: podcastId, 'processing.jobId': jobId };

    if (result.status !== 'COMPLETE') {
        const updated = await Podcast.findOneAndUpdate(
            filter,
            {
                $set: {
                    'processing.status': 'failed',
                    'processing.error':
                        (result.errorMessage || `Job ${result.status}`).slice(0, 500),
                    'processing.completedAt': now,
                    'processing.updatedAt': now,
                },
            },
            { ...ADMIN, new: true }
        );
        errorLogger.error(
            `MediaConvert job ${jobId} for podcast ${podcastId} ended ${result.status}: ${result.errorMessage ?? ''}`
        );
        return updated ? 'failed' : 'stale';
    }

    const runId = result.runId || current.runId;
    if (!runId) return 'ignored';
    const layout = outputLayout(podcastId, runId);
    const set: Record<string, unknown> = {
        hlsUrl: cdnUrl(result.hlsKey || layout.hlsMasterKey),
        'processing.status': 'ready',
        'processing.error': null,
        'processing.completedAt': now,
        'processing.updatedAt': now,
    };
    if (!podcast.durationSeconds && result.durationMs) {
        set.durationSeconds = Math.round(result.durationMs / 1000);
    }
    if (podcast.mediaType === 'video') {
        if (!podcast.coverImage) {
            set.coverImage = cdnUrl(
                result.posterKey || layout.posterKey(result.durationMs)
            );
        }
        if (!podcast.videoWidth && result.dims) {
            set.videoWidth = result.dims.width;
            set.videoHeight = result.dims.height;
        }
    }

    const updated = await Podcast.findOneAndUpdate(
        filter,
        { $set: set },
        { ...ADMIN, new: true }
    );
    if (!updated) return 'stale';

    // An admin re-run replaced an earlier conversion of the same file.
    const previousRun = runIdOfHlsUrl(podcastId, podcast.hlsUrl);
    if (previousRun && previousRun !== runId) {
        cleanup(outputLayout(podcastId, previousRun).prefix);
    }
    logger.info(`Podcast ${podcastId} is ready to stream (job ${jobId})`);
    return 'ready';
};

const largestDims = (details: any[]) => {
    let best: { width: number; height: number } | null = null;
    for (const d of details) {
        const width = Number(d?.width);
        const height = Number(d?.height);
        if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) {
            best = { width, height };
        }
    }
    return best;
};

/** Normalises an EventBridge "MediaConvert Job State Change" event. */
export const jobResultFromEvent = (event: any): JobResult | null => {
    if (
        event?.source !== 'aws.mediaconvert' ||
        event?.['detail-type'] !== 'MediaConvert Job State Change'
    ) {
        return null;
    }
    const detail = event.detail ?? {};
    const meta = detail.userMetadata ?? {};
    if (meta.app !== JOB_APP_TAG) return null;
    if (!['COMPLETE', 'ERROR', 'CANCELED'].includes(detail.status)) return null;

    const groups: any[] = detail.outputGroupDetails ?? [];
    const outputs = groups.flatMap((g) => g?.outputDetails ?? []);
    const hlsGroup = groups.find((g) => g?.type === 'HLS_GROUP');
    const fileGroup = groups.find((g) => g?.type === 'FILE_GROUP');
    const durations = outputs
        .map((o) => Number(o?.durationInMs))
        .filter((n) => n > 0);

    return {
        podcastId: String(meta.podcastId ?? ''),
        runId: meta.runId ? String(meta.runId) : null,
        jobId: String(detail.jobId ?? ''),
        status: detail.status,
        durationMs: durations.length ? Math.max(...durations) : null,
        dims: largestDims(
            (hlsGroup?.outputDetails ?? []).map((o: any) => ({
                width: o?.videoDetails?.widthInPx,
                height: o?.videoDetails?.heightInPx,
            }))
        ),
        hlsKey: keyFromS3Uri(hlsGroup?.playlistFilePaths?.[0]),
        posterKey: keyFromS3Uri(fileGroup?.outputDetails?.[0]?.outputFilePaths?.[0]),
        errorMessage: detail.errorMessage
            ? `${detail.errorCode ?? ''} ${detail.errorMessage}`.trim()
            : null,
    };
};

/** Webhook entry point. Unknown or foreign events are acknowledged and ignored. */
export const handleJobStateEvent = async (event: any) => {
    const result = jobResultFromEvent(event);
    if (!result) return { outcome: 'ignored' as JobOutcome };
    const outcome = await applyJobResult(result);
    return { outcome, podcastId: result.podcastId, jobId: result.jobId };
};

/** Normalises a GetJob response (used when a webhook never arrived). */
const jobResultFromJob = (podcastId: string, job: any): JobResult => {
    const outputs = (job?.OutputGroupDetails ?? []).flatMap(
        (g: any) => g?.OutputDetails ?? []
    );
    const durations = outputs
        .map((o: any) => Number(o?.DurationInMs))
        .filter((n: number) => n > 0);
    return {
        podcastId,
        jobId: job?.Id,
        runId: job?.UserMetadata?.runId ?? null,
        status: job?.Status,
        durationMs: durations.length ? Math.max(...durations) : null,
        dims: largestDims(
            outputs.map((o: any) => ({
                width: o?.VideoDetails?.WidthInPx,
                height: o?.VideoDetails?.HeightInPx,
            }))
        ),
        errorMessage: job?.ErrorMessage
            ? `${job?.ErrorCode ?? ''} ${job.ErrorMessage}`.trim()
            : null,
    };
};

// ---------------------------------------------------------------------------
// Sweeper: the safety net for missed webhooks and failed starts
// ---------------------------------------------------------------------------

export const sweepMedia = async (now = Date.now()) => {
    const summary = { checked: 0, finished: 0, timedOut: 0, retried: 0 };
    if (!mediaConfig().enabled) return summary;

    // One instance at a time (several API containers may run this timer).
    const lock = await redis.set(SWEEP_LOCK_KEY, String(process.pid), 'EX', 240, 'NX');
    if (lock !== 'OK') return summary;
    try {
        const stuck = await Podcast.find({
            'processing.status': 'processing',
            'processing.updatedAt': { $lt: new Date(now - CHECK_AFTER_MS) },
        })
            .setOptions(ADMIN)
            .select('processing')
            .limit(25)
            .lean();

        for (const p of stuck) {
            const id = String(p._id);
            const jobId = p.processing?.jobId;
            summary.checked += 1;
            if (!jobId) {
                await setProcessing(id, {
                    ...p.processing,
                    status: 'failed',
                    error: 'No MediaConvert job was recorded',
                    updatedAt: new Date(now),
                });
                summary.timedOut += 1;
                continue;
            }
            try {
                const { Job } = await getMediaConvert().send(
                    new GetJobCommand({ Id: jobId })
                );
                if (['COMPLETE', 'ERROR', 'CANCELED'].includes(Job?.Status)) {
                    await applyJobResult(jobResultFromJob(id, Job));
                    summary.finished += 1;
                    continue;
                }
                const started = p.processing?.startedAt
                    ? new Date(p.processing.startedAt).getTime()
                    : now;
                if (now - started > GIVE_UP_AFTER_MS) {
                    await applyJobResult({
                        podcastId: id,
                        jobId,
                        status: 'ERROR',
                        errorMessage: 'Timed out: the job ran for more than 6 hours',
                    });
                    summary.timedOut += 1;
                } else {
                    await Podcast.updateOne(
                        { _id: id, 'processing.jobId': jobId },
                        { $set: { 'processing.updatedAt': new Date(now) } }
                    );
                }
            } catch (err: any) {
                if (err?.name === 'NotFoundException') {
                    await applyJobResult({
                        podcastId: id,
                        jobId,
                        status: 'ERROR',
                        errorMessage: 'The MediaConvert job no longer exists',
                    });
                    summary.timedOut += 1;
                } else {
                    errorLogger.error(`Media sweeper could not check job ${jobId}:`, err);
                }
            }
        }

        const queued = await Podcast.find({
            'processing.status': 'queued',
            'processing.updatedAt': { $lt: new Date(now - RETRY_AFTER_MS) },
            'processing.attempts': { $lt: MAX_START_ATTEMPTS },
        })
            .setOptions(ADMIN)
            .select('_id')
            .limit(10)
            .lean();
        for (const p of queued) {
            await startTranscode(String(p._id));
            summary.retried += 1;
        }
    } finally {
        await redis.del(SWEEP_LOCK_KEY);
    }
    if (summary.checked || summary.retried) {
        logger.info(`Media sweeper: ${JSON.stringify(summary)}`);
    }
    return summary;
};

/**
 * One startup line saying whether conversion is on and what is missing, so a
 * misconfigured server is visible in `docker logs` instead of silently skipping.
 */
export const logMediaConfigStatus = () => {
    const cfg = mediaConfig();
    const raw = process.env.TRANSCODE_ENABLED;
    if (!cfg.enabled) {
        logger.info(
            `Media conversion: OFF (TRANSCODE_ENABLED=${raw === undefined ? '<not set>' : JSON.stringify(raw)}; must be exactly "true"). Uploads play their original file.`
        );
        return;
    }
    const missing = [
        !cfg.roleArn && 'MEDIACONVERT_ROLE_ARN',
        !cfg.webhookSecret && 'MEDIA_WEBHOOK_SECRET',
        !process.env.AWS_ACCESS_KEY_ID && 'AWS_ACCESS_KEY_ID',
    ].filter(Boolean);
    const summary = `region ${cfg.region}, bucket ${cfg.bucket}, CDN ${cfg.cdnBase}`;
    if (missing.length) {
        errorLogger.error(
            `Media conversion: ON but MISCONFIGURED, missing ${missing.join(', ')} (${summary})`
        );
    } else {
        logger.info(`Media conversion: ON (${summary})`);
    }
};

/** Starts the periodic sweeper (call once after the DB connects). */
export const startMediaSweeper = () => {
    logMediaConfigStatus();
    const timer = setInterval(() => {
        sweepMedia().catch((err) => errorLogger.error('Media sweeper failed:', err));
    }, SWEEP_EVERY_MS);
    timer.unref();
    return timer;
};

const mediaService = {
    startTranscode,
    reprocessPodcast,
    applyJobResult,
    handleJobStateEvent,
    sweepMedia,
    startMediaSweeper,
    deleteMediaFolder,
};
export default mediaService;
