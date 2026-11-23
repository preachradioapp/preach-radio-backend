import { Types } from 'mongoose';

export const PODCAST_MEDIA_TYPES = ['audio', 'video'] as const;
export const PODCAST_STATUS = ['published', 'hidden'] as const;
/** `episode` = full podcast, `clip` = Preach Clip / reel (max 2 minutes). */
export const PODCAST_TYPES = ['episode', 'clip'] as const;

/**
 * Server-side conversion of the uploaded media to streaming formats (HLS).
 * queued     = waiting to (re)try starting the job
 * processing = MediaConvert job running
 * ready      = `hlsUrl` is set
 * failed     = gave up; the original `podcast_url` still plays
 * skipped    = media is not in the app's bucket (e.g. an external link)
 */
export const MEDIA_PROCESSING_STATUS = [
    'queued',
    'processing',
    'ready',
    'failed',
    'skipped',
] as const;
export type TMediaProcessingStatus = (typeof MEDIA_PROCESSING_STATUS)[number];

export interface IMediaProcessing {
    status: TMediaProcessingStatus;
    jobId?: string | null;
    /** Output folder of this run: media/<podcastId>/<runId>/ */
    runId?: string | null;
    error?: string | null;
    /** Start attempts for the current media file (reset when the file changes). */
    attempts?: number;
    startedAt?: Date | null;
    completedAt?: Date | null;
    updatedAt?: Date;
}

export type TPodcastMediaType = (typeof PODCAST_MEDIA_TYPES)[number];
export type TPodcastStatus = (typeof PODCAST_STATUS)[number];
export type TPodcastType = (typeof PODCAST_TYPES)[number];

export interface IPodcast {
    /** Set for creator uploads. A podcast belongs to a creator OR the station. */
    creator?: Types.ObjectId | null;
    /** Set for platform (admin) uploads. */
    station?: Types.ObjectId | null;
    category: Types.ObjectId;
    subCategory: Types.ObjectId;
    coverImage?: string;
    /** The original upload. Always playable; kept as the fallback. */
    podcast_url?: string;
    /** Adaptive stream (HLS master playlist), set once conversion finishes. Prefer it over podcast_url. */
    hlsUrl?: string | null;
    processing?: IMediaProcessing | null;
    /** Source video size as displayed (rotation applied); decides the HLS ladder's orientation. */
    videoWidth?: number | null;
    videoHeight?: number | null;
    mediaType?: TPodcastMediaType;
    type?: TPodcastType;
    /** Clips: the full episode this clip was cut from ("watch full message"). */
    sourcePodcast?: Types.ObjectId | null;
    status?: TPodcastStatus;
    title: string;
    description: string;
    /** Required for episodes, optional for clips. */
    location?: {
        type: 'Point';
        coordinates: [number, number];
    };
    address?: string;
    tags: string[];
    totalView: number;
    totalLikes: number;
    /** Legacy field, format unchanged (see docs). */
    duration: number;
    /** Length in whole seconds — unambiguous; used for the 2-minute clip rule. */
    durationSeconds?: number;
    createdAt: Date;
    updatedAt: Date;
}
