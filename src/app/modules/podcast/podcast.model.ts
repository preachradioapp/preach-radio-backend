import { PipelineStage, Query, Schema, model } from 'mongoose';
import { deleteByPattern, deleteKeys } from '../../utilities/cache';
import {
    IPodcast,
    PODCAST_MEDIA_TYPES,
    PODCAST_STATUS,
    PODCAST_TYPES,
} from './podcast.interface';
import { CLIP_MAX_SECONDS } from './podcast.constant';

/** Best-effort media type detection for podcasts created without an explicit `mediaType`. */
export const detectMediaType = (url?: string | null) =>
    url && /podcast_video|\.(mp4|mov|webm|m4v|m3u8)(\?|$)/i.test(url)
        ? 'video'
        : 'audio';

// Sub-schema so that an unset location is truly absent. The previous inline
// definition always created `{ type: 'Point' }` (from the default), which the
// 2dsphere index rejects when coordinates are missing — clips have no location.
const PointSchema = new Schema(
    {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], required: true },
    },
    { _id: false }
);

// eslint-disable-next-line no-unused-vars -- typed `this` parameter (used below), not a real argument
const isEpisode = function (this: { type?: string }) {
    return this.type !== 'clip';
};

const PodcastSchema = new Schema<IPodcast>(
    {
        creator: {
            type: Schema.Types.ObjectId,
            ref: 'Creator',
            default: null,
        },
        station: {
            type: Schema.Types.ObjectId,
            ref: 'Station',
            default: null,
        },
        category: {
            type: Schema.Types.ObjectId,
            ref: 'Category',
            required: true,
        },
        subCategory: {
            type: Schema.Types.ObjectId,
            ref: 'SubCategory',
            required: true,
        },
        // Optional: apps/dashboard may publish without a cover and show a placeholder.
        coverImage: { type: String },
        podcast_url: { type: String },
        mediaType: {
            type: String,
            enum: PODCAST_MEDIA_TYPES,
        },
        // Existing documents have no `type`; see podcast.constant.ts for how
        // they are classified (legacy duration rule).
        type: {
            type: String,
            enum: PODCAST_TYPES,
            default: 'episode',
        },
        sourcePodcast: {
            type: Schema.Types.ObjectId,
            ref: 'Podcast',
            default: null,
        },
        // Hidden podcasts are excluded from every query by the hooks below.
        // Existing documents have no `status`, which counts as published.
        status: {
            type: String,
            enum: PODCAST_STATUS,
            default: 'published',
        },
        title: { type: String, required: true, trim: true },
        description: { type: String, required: true },
        location: {
            type: PointSchema,
            required: isEpisode,
        },
        address: { type: String, required: isEpisode },
        tags: [{ type: String }],
        totalView: {
            type: Number,
            default: 0,
        },
        // Denormalised counter, kept in sync with the Like collection.
        totalLikes: {
            type: Number,
            default: 0,
            min: 0,
        },
        duration: {
            type: Number,
            required: true,
        },
        durationSeconds: {
            type: Number,
            min: 0,
        },
    },
    { timestamps: true }
);

PodcastSchema.pre('validate', function (next) {
    if (!this.mediaType) this.mediaType = detectMediaType(this.podcast_url);
    if (this.type === 'clip') {
        if (typeof this.durationSeconds !== 'number') {
            this.invalidate(
                'durationSeconds',
                'Clips need their length in seconds (durationSeconds)'
            );
        } else if (this.durationSeconds > CLIP_MAX_SECONDS) {
            this.invalidate(
                'durationSeconds',
                `Clips can be at most ${CLIP_MAX_SECONDS / 60} minutes long`
            );
        }
    }
    if (this.sourcePodcast && this.sourcePodcast.equals?.(this._id)) {
        this.invalidate('sourcePodcast', 'A clip cannot be its own source');
    }
    // A podcast belongs to exactly one owner: a creator OR the platform station.
    if (Boolean(this.creator) === Boolean(this.station)) {
        this.invalidate(
            'creator',
            'A podcast must belong to either a creator or the station'
        );
    }
    next();
});

// ---------------------------------------------------------------------------
// Indexes — shaped after the queries the app actually runs.
// ---------------------------------------------------------------------------
PodcastSchema.index({ location: '2dsphere' });
PodcastSchema.index({ createdAt: -1 }); // default list / latest
PodcastSchema.index({ creator: 1, createdAt: -1 }); // creator profile & "my podcasts"
PodcastSchema.index({ station: 1, createdAt: -1 }); // station podcasts
PodcastSchema.index({ category: 1, createdAt: -1 }); // browse by category
PodcastSchema.index({ subCategory: 1, createdAt: -1 }); // browse by subcategory
PodcastSchema.index({ type: 1, createdAt: -1 }); // reels / clips feed
PodcastSchema.index({ duration: 1 }); // legacy reels rule for untyped records
PodcastSchema.index({ totalView: -1 }); // popular / trending
// Unchanged from before on purpose: MongoDB allows one text index per collection and
// changing its definition would conflict with the existing index in production.
PodcastSchema.index({ title: 'text', name: 'text', description: 'text' });

// ---------------------------------------------------------------------------
// Visibility: hidden podcasts never reach app queries.
// Admin code opts out with `.setOptions({ includeHidden: true })` (find) or
// `Podcast.aggregate(p).option({ includeHidden: true } as never)`.
// ---------------------------------------------------------------------------
const VISIBLE = { status: { $ne: 'hidden' } };

// eslint-disable-next-line no-unused-vars -- typed `this` parameter (used below), not a real argument
function applyVisibility(this: Query<unknown, IPodcast>) {
    if (this.getOptions().includeHidden) return;
    this.where(VISIBLE);
}

PodcastSchema.pre(
    [
        'find',
        'findOne',
        'countDocuments',
        'findOneAndUpdate',
        'findOneAndDelete',
    ],
    applyVisibility
);

PodcastSchema.pre('aggregate', function () {
    if ((this.options as { includeHidden?: boolean }).includeHidden) return;
    const pipeline = this.pipeline() as PipelineStage[];
    const first = pipeline[0] as PipelineStage.GeoNear | undefined;
    // $geoNear must stay the first stage, so merge the filter into its query.
    if (first && '$geoNear' in first) {
        first.$geoNear.query = {
            ...(first.$geoNear.query || {}),
            ...VISIBLE,
        };
    } else {
        pipeline.unshift({ $match: VISIBLE });
    }
});

// ---------------------------------------------------------------------------
// Cache invalidation on every kind of write (previously only on `save`, so
// edits and deletes left the home feed stale).
// ---------------------------------------------------------------------------
const invalidateCaches = async (doc?: { creator?: unknown } | null) => {
    await deleteKeys('home:data');
    if (doc?.creator) await deleteByPattern(`user:${doc.creator}:*`);
};

PodcastSchema.post('save', invalidateCaches);
PodcastSchema.post('findOneAndUpdate', invalidateCaches);
PodcastSchema.post('findOneAndDelete', invalidateCaches);
PodcastSchema.post(
    'deleteOne',
    { document: true, query: false },
    invalidateCaches
);

const Podcast = model<IPodcast>('Podcast', PodcastSchema);
export default Podcast;
