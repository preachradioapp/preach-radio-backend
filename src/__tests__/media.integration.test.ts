/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
/**
 * Media conversion (MediaConvert → HLS): job settings, starting jobs, the
 * EventBridge webhook, the sweeper and S3 cleanup — against an in-memory MongoDB,
 * with fake Redis, MediaConvert and S3 clients. No AWS calls are made.
 *
 *   npm test
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Fake Redis — registered before any app module loads.
// ---------------------------------------------------------------------------
const store = new Map<string, string>();
const fakeRedis = {
    on: () => fakeRedis,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => (store.set(k, v), 'OK'),
    del: async (...keys: string[]) => keys.filter((k) => store.delete(k)).length,
    unlink: async (...keys: string[]) => keys.filter((k) => store.delete(k)).length,
    keys: async () => [...store.keys()],
    scanStream: () =>
        (async function* () {
            yield [...store.keys()];
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
const podcastService = require('../app/modules/podcast/podcast.service').default;
const media = require('../app/modules/media/media.service');
const { setMediaClients, deleteS3Prefix } = require('../app/modules/media/media.aws');
const jobs = require('../app/modules/media/media.jobSettings');
const { secretMatches } = require('../app/modules/media/media.controller');

const CDN = 'https://d2263773avtgf9.cloudfront.net';
const VIDEO_URL = `${CDN}/uploads/images/podcast_videos/1794-abc.mp4`;
const AUDIO_URL = `${CDN}/uploads/podcast_audios/1794-def.mpeg`;
const superAdmin = { profileId: String(new mongoose.Types.ObjectId()), role: 'superAdmin' };
const raw = (name: string) => mongoose.connection.collection(name);
const flush = () => new Promise((r) => setTimeout(r, 20));

// ---------------------------------------------------------------------------
// Fake AWS clients
// ---------------------------------------------------------------------------
let createRequests: any[] = [];
let createError: any = null;
let getJobResponse: any = null;
let getJobError: any = null;
let listedPrefixes: string[] = [];
let deletedKeys: string[] = [];
let jobCounter = 0;

const fakeMediaConvert = {
    send: async (cmd: any) => {
        const name = cmd.constructor.name;
        if (name === 'CreateJobCommand') {
            if (createError) throw createError;
            createRequests.push(cmd.input);
            jobCounter += 1;
            return { Job: { Id: `job-${jobCounter}` } };
        }
        if (name === 'GetJobCommand') {
            if (getJobError) throw getJobError;
            return { Job: getJobResponse };
        }
        throw new Error(`unexpected command ${name}`);
    },
};
const fakeS3 = {
    send: async (cmd: any) => {
        const name = cmd.constructor.name;
        if (name === 'ListObjectsV2Command') {
            listedPrefixes.push(cmd.input.Prefix);
            return { Contents: [{ Key: `${cmd.input.Prefix}x.ts` }], IsTruncated: false };
        }
        if (name === 'DeleteObjectsCommand') {
            deletedKeys.push(...cmd.input.Delete.Objects.map((o: any) => o.Key));
            return {};
        }
        throw new Error(`unexpected command ${name}`);
    },
};

const awsError = (name: string, message = name) =>
    Object.assign(new Error(message), { name });

let categoryId: any;
let subCategoryId: any;
let mongo: any;

const body = (overrides: Record<string, unknown> = {}) => ({
    category: String(categoryId),
    subCategory: String(subCategoryId),
    podcast_url: VIDEO_URL,
    mediaType: 'video',
    title: 'Sunday sermon',
    description: 'd',
    location: { type: 'Point', coordinates: [3.38, 6.52] },
    address: 'Lagos',
    duration: 45,
    durationSeconds: 2700,
    ...overrides,
});

/** An EventBridge "MediaConvert Job State Change" event as AWS sends it. */
const event = (podcast: any, status: string, extra: Record<string, unknown> = {}) => ({
    version: '0',
    source: 'aws.mediaconvert',
    'detail-type': 'MediaConvert Job State Change',
    detail: {
        status,
        jobId: podcast.processing.jobId,
        userMetadata: {
            app: 'preach-radio',
            podcastId: String(podcast._id),
            runId: podcast.processing.runId,
        },
        ...extra,
    },
});

const completeDetail = (podcast: any) => {
    const prefix = `media/${podcast._id}/${podcast.processing.runId}/`;
    return {
        outputGroupDetails: [
            {
                type: 'HLS_GROUP',
                playlistFilePaths: [`s3://preach-radio/${prefix}hls/master.m3u8`],
                outputDetails: [
                    { durationInMs: 2701000, videoDetails: { widthInPx: 854, heightInPx: 480 } },
                    { durationInMs: 2701000, videoDetails: { widthInPx: 1280, heightInPx: 720 } },
                ],
            },
            {
                type: 'FILE_GROUP',
                outputDetails: [
                    {
                        outputFilePaths: [`s3://preach-radio/${prefix}poster/frame.0000001.jpg`],
                        durationInMs: 2701000,
                    },
                ],
            },
        ],
    };
};

before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Podcast.init();
});

after(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});

beforeEach(async () => {
    await Promise.all(
        ['podcasts', 'categories', 'subcategories', 'stations', 'creators', 'likes', 'albums'].map(
            (c) => raw(c).deleteMany({})
        )
    );
    store.clear();
    createRequests = [];
    createError = null;
    getJobResponse = null;
    getJobError = null;
    listedPrefixes = [];
    deletedKeys = [];
    setMediaClients({ mediaConvert: fakeMediaConvert, s3: fakeS3 });
    Object.assign(process.env, {
        TRANSCODE_ENABLED: 'true',
        MEDIACONVERT_ROLE_ARN: 'arn:aws:iam::000000000000:role/PreachRadioMediaConvertRole',
        AWS_S3_BUCKET_NAME: 'preach-radio',
        CLOUDFRONT_URL: CDN,
        MEDIA_WEBHOOK_SECRET: 'a'.repeat(64),
    });
    categoryId = (await raw('categories').insertOne({ name: 'Sermons' })).insertedId;
    subCategoryId = (
        await raw('subcategories').insertOne({ name: 'Weekly', category: categoryId })
    ).insertedId;
    await raw('stations').insertOne({ name: 'Preach Radio' });
});

afterEach(() => setMediaClients({}));

const fresh = (id: any) => Podcast.findById(id).setOptions({ includeHidden: true }).lean();

// ---------------------------------------------------------------------------
describe('job settings', () => {
    const base = {
        bucket: 'preach-radio',
        inputKey: 'uploads/images/podcast_videos/a.mp4',
        podcastId: 'a'.repeat(24),
        runId: 'run1',
    };

    it('video: HLS 480p + 720p by height, a poster frame, Basic-tier settings only', () => {
        const req = jobs.buildCreateJobRequest({
            ...base,
            mediaType: 'video',
            orientation: 'landscape',
            renditions: jobs.RENDITIONS,
            roleArn: 'arn:role',
        });
        const [hls, poster] = req.Settings.OutputGroups;
        assert.equal(hls.OutputGroupSettings.Type, 'HLS_GROUP_SETTINGS');
        assert.equal(
            hls.OutputGroupSettings.HlsGroupSettings.Destination,
            `s3://preach-radio/media/${base.podcastId}/run1/hls/master`
        );
        assert.deepEqual(
            hls.Outputs.map((o: any) => [o.NameModifier, o.VideoDescription.Height, o.VideoDescription.Width]),
            [
                ['_480p', 480, undefined],
                ['_720p', 720, undefined],
            ]
        );
        for (const o of hls.Outputs) {
            const h264 = o.VideoDescription.CodecSettings.H264Settings;
            assert.equal(h264.RateControlMode, 'QVBR');
            assert.equal(h264.QualityTuningLevel, 'SINGLE_PASS');
            assert.equal(o.AudioDescriptions[0].CodecSettings.Codec, 'AAC');
        }
        assert.equal(poster.OutputGroupSettings.Type, 'FILE_GROUP_SETTINGS');
        assert.equal(poster.Outputs[0].VideoDescription.CodecSettings.Codec, 'FRAME_CAPTURE');
        assert.equal(req.Settings.Inputs[0].FileInput, `s3://preach-radio/${base.inputKey}`);
        assert.equal(req.Settings.Inputs[0].VideoSelector.Rotate, 'AUTO');
        assert.deepEqual(req.UserMetadata, { app: 'preach-radio', podcastId: base.podcastId, runId: 'run1' });
        assert.equal(req.AccelerationSettings.Mode, 'DISABLED');
        assert.equal(req.Role, 'arn:role');
    });

    it('portrait video is scaled by width, so vertical clips stay sharp at 9:16', () => {
        const settings = jobs.buildJobSettings({
            ...base,
            mediaType: 'video',
            orientation: 'portrait',
            renditions: jobs.RENDITIONS,
        });
        assert.deepEqual(
            settings.OutputGroups[0].Outputs.map((o: any) => [o.VideoDescription.Width, o.VideoDescription.Height]),
            [
                [480, undefined],
                [720, undefined],
            ]
        );
    });

    it('audio: one audio-only HLS rendition, no video outputs or poster', () => {
        const settings = jobs.buildJobSettings({
            ...base,
            mediaType: 'audio',
            orientation: 'landscape',
            renditions: jobs.RENDITIONS,
        });
        assert.equal(settings.OutputGroups.length, 1);
        const [out] = settings.OutputGroups[0].Outputs;
        assert.equal(out.VideoDescription, undefined);
        assert.equal(out.AudioDescriptions[0].CodecSettings.AacSettings.Bitrate, 128000);
        assert.equal(settings.Inputs[0].VideoSelector, undefined);
    });

    it('orientation and ladder follow the real size; clips default to vertical', () => {
        assert.equal(jobs.orientationOf({ videoWidth: 1080, videoHeight: 1920 }), 'portrait');
        assert.equal(jobs.orientationOf({ videoWidth: 1920, videoHeight: 1080 }), 'landscape');
        assert.equal(jobs.orientationOf({ type: 'clip' }), 'portrait');
        assert.equal(jobs.orientationOf({ type: 'episode' }), 'landscape');
        const names = (p: any) => jobs.renditionsFor(p).map((r: any) => r.name);
        assert.deepEqual(names({}), ['480p', '720p']);
        assert.deepEqual(names({ videoWidth: 1080, videoHeight: 1920 }), ['480p', '720p']);
        assert.deepEqual(names({ videoWidth: 960, videoHeight: 540 }), ['480p']); // no upscaling
        assert.deepEqual(names({ videoWidth: 640, videoHeight: 360 }), ['480p']); // smallest rung kept
    });

    it('poster key: the frame at ~3 s, or the first frame of very short videos', () => {
        const layout = jobs.outputLayout('a'.repeat(24), 'r');
        assert.match(layout.posterKey(45000), /frame\.0000001\.jpg$/);
        assert.match(layout.posterKey(2000), /frame\.0000000\.jpg$/);
    });
});

// ---------------------------------------------------------------------------
describe('starting a conversion', () => {
    it('creating a podcast starts a job for its S3 file and records it', async () => {
        const p = await podcastService.createPodcastIntoDB(superAdmin, body());
        assert.equal(createRequests.length, 1);
        assert.equal(
            createRequests[0].Settings.Inputs[0].FileInput,
            's3://preach-radio/uploads/images/podcast_videos/1794-abc.mp4'
        );
        assert.equal(p.processing.status, 'processing');
        assert.equal(p.processing.jobId, 'job-1');
        assert.ok(p.processing.runId);
        assert.equal(p.processing.attempts, 1);
        assert.equal(p.hlsUrl, null);
    });

    it('does nothing while TRANSCODE_ENABLED is off', async () => {
        process.env.TRANSCODE_ENABLED = 'false';
        const p = await podcastService.createPodcastIntoDB(superAdmin, body());
        assert.equal(createRequests.length, 0);
        assert.equal(p.processing, null);
    });

    it('uses the uploaded video size to pick the ladder (vertical upload → scaled by width)', async () => {
        await podcastService.createPodcastIntoDB(
            superAdmin,
            body({ videoWidth: 1080, videoHeight: 1920 })
        );
        const out = createRequests[0].Settings.OutputGroups[0].Outputs[1];
        assert.equal(out.VideoDescription.Width, 720);
    });

    it('skips media that is not in the app bucket (external links)', async () => {
        const p = await podcastService.createPodcastIntoDB(
            superAdmin,
            body({ podcast_url: 'https://example.com/sermon.mp4' })
        );
        assert.equal(createRequests.length, 0);
        assert.equal(p.processing.status, 'skipped');
    });

    it('a temporary AWS error queues a retry; the sweeper starts it later', async () => {
        createError = awsError('TooManyRequestsException');
        const p = await podcastService.createPodcastIntoDB(superAdmin, body());
        assert.equal(p.processing.status, 'queued');
        assert.equal(p.processing.attempts, 1);
        assert.match(p.processing.error, /TooManyRequests/);

        createError = null;
        await media.sweepMedia(Date.now()); // too soon: waits 2 minutes before retrying
        assert.equal(createRequests.length, 0);
        await media.sweepMedia(Date.now() + 3 * 60_000);
        const after = await fresh(p._id);
        assert.equal(after.processing.status, 'processing');
        assert.equal(after.processing.attempts, 2);
    });

    it('a permanent error (e.g. no permission) fails at once, and the upload still succeeds', async () => {
        createError = awsError('ForbiddenException', 'not authorized to perform iam:PassRole');
        const p = await podcastService.createPodcastIntoDB(superAdmin, body());
        assert.ok(p._id, 'podcast was created');
        assert.equal(p.podcast_url, VIDEO_URL, 'original file still plays');
        assert.equal(p.processing.status, 'failed');
        assert.match(p.processing.error, /PassRole/);
    });

    it('gives up after 3 failed start attempts', async () => {
        createError = awsError('InternalServerErrorException');
        const p = await podcastService.createPodcastIntoDB(superAdmin, body());
        await media.sweepMedia(Date.now() + 3 * 60_000);
        await media.sweepMedia(Date.now() + 6 * 60_000);
        const after = await fresh(p._id);
        assert.equal(after.processing.status, 'failed');
        assert.equal(after.processing.attempts, 3);
    });
});

// ---------------------------------------------------------------------------
describe('job results (webhook)', () => {
    it('COMPLETE sets hlsUrl, a poster cover when none was uploaded, size and duration', async () => {
        const created = await podcastService.createPodcastIntoDB(
            superAdmin,
            body({ durationSeconds: undefined })
        );
        const res = await media.handleJobStateEvent(
            event(created, 'COMPLETE', completeDetail(created))
        );
        assert.equal(res.outcome, 'ready');
        const p = await fresh(created._id);
        const prefix = `media/${created._id}/${created.processing.runId}/`;
        assert.equal(p.hlsUrl, `${CDN}/${prefix}hls/master.m3u8`);
        assert.equal(p.coverImage, `${CDN}/${prefix}poster/frame.0000001.jpg`);
        assert.equal(p.processing.status, 'ready');
        assert.ok(p.processing.completedAt);
        assert.equal(p.durationSeconds, 2701);
        assert.deepEqual([p.videoWidth, p.videoHeight], [1280, 720]);
    });

    it('keeps an uploaded cover and the client-measured duration', async () => {
        const created = await podcastService.createPodcastIntoDB(
            superAdmin,
            body({ coverImage: `${CDN}/uploads/documents/podcast_cover/c.jpg` })
        );
        await media.handleJobStateEvent(event(created, 'COMPLETE', completeDetail(created)));
        const p = await fresh(created._id);
        assert.equal(p.coverImage, `${CDN}/uploads/documents/podcast_cover/c.jpg`);
        assert.equal(p.durationSeconds, 2700);
    });

    it('is idempotent: a repeated event changes nothing', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        const e = event(created, 'COMPLETE', completeDetail(created));
        assert.equal((await media.handleJobStateEvent(e)).outcome, 'ready');
        assert.equal((await media.handleJobStateEvent(e)).outcome, 'duplicate');
    });

    it('ERROR marks the podcast failed; apps see only the status, admins see the reason', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        const res = await media.handleJobStateEvent(
            event(created, 'ERROR', { errorCode: 1010, errorMessage: 'Unsupported codec' })
        );
        assert.equal(res.outcome, 'failed');
        const p = await fresh(created._id);
        assert.equal(p.processing.status, 'failed');
        assert.match(p.processing.error, /Unsupported codec/);
        assert.equal(p.hlsUrl, null);

        const appView = await podcastService.getSinglePodcast(String(created._id), null);
        assert.deepEqual(appView.processing, { status: 'failed' });
        const adminView = await podcastService.getSinglePodcast(String(created._id), superAdmin);
        assert.match(adminView.processing.error, /Unsupported codec/);
    });

    it('ignores events from other apps, other sources and progress updates', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        const foreign = event(created, 'COMPLETE');
        foreign.detail.userMetadata.app = 'another-project';
        assert.equal((await media.handleJobStateEvent(foreign)).outcome, 'ignored');
        assert.equal(
            (await media.handleJobStateEvent({ ...event(created, 'COMPLETE'), source: 'aws.s3' })).outcome,
            'ignored'
        );
        assert.equal((await media.handleJobStateEvent(event(created, 'PROGRESSING'))).outcome, 'ignored');
        assert.equal((await media.handleJobStateEvent({})).outcome, 'ignored');
        assert.equal((await fresh(created._id)).processing.status, 'processing');
    });

    it('a result for replaced media is stale: not applied, and its files are deleted', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        const oldEvent = event(created, 'COMPLETE', completeDetail(created));
        await podcastService.updatePodcastIntoDB(superAdmin, String(created._id), {
            podcast_url: `${CDN}/uploads/images/podcast_videos/new.mp4`,
        });
        listedPrefixes = [];
        const res = await media.handleJobStateEvent(oldEvent);
        assert.equal(res.outcome, 'stale');
        await flush();
        assert.deepEqual(listedPrefixes, [`media/${created._id}/${created.processing.runId}/`]);
        const p = await fresh(created._id);
        assert.equal(p.hlsUrl, null);
        assert.equal(p.processing.status, 'processing');
        assert.notEqual(p.processing.jobId, created.processing.jobId);
    });

    it('a result for a deleted podcast removes the files it wrote', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        await Podcast.deleteOne({ _id: created._id });
        const res = await media.handleJobStateEvent(event(created, 'COMPLETE', completeDetail(created)));
        assert.equal(res.outcome, 'deleted');
        await flush();
        assert.deepEqual(listedPrefixes, [`media/${created._id}/`]);
    });

    it('the webhook secret is compared exactly', () => {
        const secret = 'a'.repeat(64);
        assert.equal(secretMatches(secret, secret), true);
        assert.equal(secretMatches('a'.repeat(63) + 'b', secret), false);
        assert.equal(secretMatches('a', secret), false);
        assert.equal(secretMatches(undefined, secret), false);
        assert.equal(secretMatches(secret, ''), false);
    });
});

// ---------------------------------------------------------------------------
describe('media lifecycle', () => {
    it('replacing the media clears the old stream and auto poster, deletes old files and re-converts', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        await media.handleJobStateEvent(event(created, 'COMPLETE', completeDetail(created)));
        listedPrefixes = [];

        const updated = await podcastService.updatePodcastIntoDB(superAdmin, String(created._id), {
            podcast_url: `${CDN}/uploads/images/podcast_videos/new.mp4`,
        });
        assert.equal(updated.hlsUrl, null);
        assert.equal(updated.coverImage, null, 'poster of the old video removed');
        assert.equal(updated.videoWidth, null);
        assert.equal(updated.processing.status, 'processing');
        assert.equal(updated.processing.attempts, 1);
        assert.equal(createRequests.length, 2);
        await flush();
        assert.ok(listedPrefixes.includes(`media/${created._id}/`));
    });

    it('editing only the title does not re-convert', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        await podcastService.updatePodcastIntoDB(superAdmin, String(created._id), { title: 'New title' });
        assert.equal(createRequests.length, 1);
    });

    it('deleting a podcast deletes its converted files', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        await podcastService.deletePodcastFromDB(superAdmin, String(created._id));
        await flush();
        assert.ok(listedPrefixes.includes(`media/${created._id}/`));
    });

    it('admin re-run keeps the current stream until the new one is ready, then removes the old run', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        await media.handleJobStateEvent(event(created, 'COMPLETE', completeDetail(created)));
        const firstHls = (await fresh(created._id)).hlsUrl;

        const rerun = await media.reprocessPodcast(String(created._id));
        assert.equal(rerun.processing.status, 'processing');
        assert.equal(rerun.hlsUrl, firstHls, 'old stream still playing');

        listedPrefixes = [];
        await media.handleJobStateEvent(event(rerun, 'COMPLETE', completeDetail(rerun)));
        await flush();
        const p = await fresh(created._id);
        assert.match(p.hlsUrl, new RegExp(rerun.processing.runId));
        assert.deepEqual(listedPrefixes, [`media/${created._id}/${created.processing.runId}/`]);
    });

    it('admin re-run is refused while conversion is turned off', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        process.env.TRANSCODE_ENABLED = 'false';
        await assert.rejects(media.reprocessPodcast(String(created._id)), /turned off/);
    });

    it('audio uploads convert too and play from the same hlsUrl field', async () => {
        const created = await podcastService.createPodcastIntoDB(
            superAdmin,
            body({ podcast_url: AUDIO_URL, mediaType: 'audio' })
        );
        const groups = createRequests[0].Settings.OutputGroups;
        assert.equal(groups.length, 1);
        await media.handleJobStateEvent(
            event(created, 'COMPLETE', {
                outputGroupDetails: [{ type: 'HLS_GROUP', outputDetails: [{ durationInMs: 1000 }] }],
            })
        );
        const p = await fresh(created._id);
        assert.match(p.hlsUrl, /hls\/master\.m3u8$/);
        assert.equal(p.coverImage, undefined, 'no poster for audio');
    });

    it('lists expose hlsUrl and the processing status to the apps', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        await media.handleJobStateEvent(event(created, 'COMPLETE', completeDetail(created)));
        const { result } = await podcastService.getAllPodcasts({});
        assert.match(result[0].hlsUrl, /master\.m3u8$/);
        assert.deepEqual(result[0].processing, { status: 'ready' });
    });
});

// ---------------------------------------------------------------------------
describe('sweeper (missed webhooks)', () => {
    const hourLater = () => Date.now() + 15 * 60_000;

    it('finishes a job whose webhook never arrived, using GetJob', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        getJobResponse = {
            Id: created.processing.jobId,
            Status: 'COMPLETE',
            UserMetadata: { app: 'preach-radio', podcastId: String(created._id), runId: created.processing.runId },
            OutputGroupDetails: [
                { OutputDetails: [{ DurationInMs: 2701000, VideoDetails: { WidthInPx: 1280, HeightInPx: 720 } }] },
            ],
        };
        const summary = await media.sweepMedia(hourLater());
        assert.equal(summary.finished, 1);
        const p = await fresh(created._id);
        assert.equal(p.processing.status, 'ready');
        assert.match(p.hlsUrl, new RegExp(`media/${created._id}/${created.processing.runId}/hls/master.m3u8$`));
    });

    it('leaves a still-running job alone, then gives up after 6 hours', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        getJobResponse = { Id: created.processing.jobId, Status: 'PROGRESSING' };
        await media.sweepMedia(hourLater());
        assert.equal((await fresh(created._id)).processing.status, 'processing');

        await media.sweepMedia(Date.now() + 7 * 60 * 60_000);
        const p = await fresh(created._id);
        assert.equal(p.processing.status, 'failed');
        assert.match(p.processing.error, /6 hours/);
    });

    it('a late COMPLETE still wins after a timeout', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        getJobResponse = { Id: created.processing.jobId, Status: 'PROGRESSING' };
        await media.sweepMedia(Date.now() + 7 * 60 * 60_000);
        const res = await media.handleJobStateEvent(event(created, 'COMPLETE', completeDetail(created)));
        assert.equal(res.outcome, 'ready');
    });

    it('marks a job that no longer exists as failed', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        getJobError = awsError('NotFoundException');
        await media.sweepMedia(hourLater());
        assert.equal((await fresh(created._id)).processing.status, 'failed');
    });

    it('does nothing while conversion is turned off', async () => {
        await podcastService.createPodcastIntoDB(superAdmin, body());
        process.env.TRANSCODE_ENABLED = 'false';
        const summary = await media.sweepMedia(hourLater());
        assert.equal(summary.checked, 0);
    });
});

// ---------------------------------------------------------------------------
describe('webhook over HTTP (real Express app)', () => {
    let server: any;
    let base = '';
    before(async () => {
        const app = require('../app').default;
        server = app.listen(0);
        await new Promise((r) => server.once('listening', r));
        base = `http://127.0.0.1:${server.address().port}/webhooks/mediaconvert`;
    });
    after(() => {
        server?.close();
        // Importing the app registers node-cron jobs (banners, users, history);
        // stop them so the test process can exit.
        require('node-cron')
            .getTasks()
            .forEach((task: any) => task.stop());
    });

    const post = (payload: unknown, headers: Record<string, string> = {}) =>
        fetch(base, {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
            body: JSON.stringify(payload),
        });

    it('rejects a missing or wrong secret with 401', async () => {
        assert.equal((await post({})).status, 401);
        assert.equal((await post({}, { 'x-webhook-secret': 'nope' })).status, 401);
    });

    it('answers 503 when the server has no secret configured', async () => {
        process.env.MEDIA_WEBHOOK_SECRET = '';
        assert.equal((await post({}, { 'x-webhook-secret': 'x' })).status, 503);
    });

    it('applies a real event end to end', async () => {
        const created = await podcastService.createPodcastIntoDB(superAdmin, body());
        const res = await post(event(created, 'COMPLETE', completeDetail(created)), {
            'x-webhook-secret': 'a'.repeat(64),
        });
        assert.equal(res.status, 200);
        const json: any = await res.json();
        assert.equal(json.data.outcome, 'ready');
        assert.equal((await fresh(created._id)).processing.status, 'ready');
    });
});

// ---------------------------------------------------------------------------
describe('S3 cleanup safety', () => {
    it('only deletes inside media/<podcastId>/', async () => {
        await assert.rejects(deleteS3Prefix(''), /Refusing/);
        await assert.rejects(deleteS3Prefix('media/'), /Refusing/);
        await assert.rejects(deleteS3Prefix('uploads/'), /Refusing/);
        await assert.rejects(deleteS3Prefix('media/abc/'), /Refusing/);
        const id = 'a'.repeat(24);
        assert.equal(await deleteS3Prefix(`media/${id}/`), 1);
        assert.deepEqual(deletedKeys, [`media/${id}/x.ts`]);
    });
});
