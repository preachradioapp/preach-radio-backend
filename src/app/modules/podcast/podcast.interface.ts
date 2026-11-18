import { Types } from 'mongoose';

export const PODCAST_MEDIA_TYPES = ['audio', 'video'] as const;
export const PODCAST_STATUS = ['published', 'hidden'] as const;
/** `episode` = full podcast, `clip` = Preach Clip / reel (max 2 minutes). */
export const PODCAST_TYPES = ['episode', 'clip'] as const;

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
    podcast_url?: string;
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
