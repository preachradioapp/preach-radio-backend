/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import { JwtPayload } from 'jsonwebtoken';
import mongoose, { PipelineStage } from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import { CACHE_TTL_SECONDS } from '../../constant';
import AppError from '../../error/appError';
import { createCacheKey } from '../../helper/createCacheKey';
import { deleteFileFromS3 } from '../../helper/deleteFromS3';
import { getCloudFrontUrl } from '../../helper/getCloudFontUrl';
import redis from '../../utilities/redisClient';
import Album from '../album/album.model';
import Bookmark from '../bookmark/bookmark.model';
import Category from '../category/category.model';
import Comment from '../comment/comment.model';
import Creator from '../creator/creator.model';
import SubCategory from '../subCategory/subCategory.model';
import { USER_ROLE } from '../user/user.constant';
import WatchHistory from '../watchHistory/watchHistory.model';
import { IPodcast, PODCAST_STATUS, TPodcastStatus } from './podcast.interface';
import Podcast, { detectMediaType } from './podcast.model';
import Like from '../like/like.model';
import playlistService from '../playlist/playlist.service';
import { deleteKeys, userCacheKeys } from '../../utilities/cache';
import { Station } from '../station/station.model';
import { escapeRegex } from '../../helper/sanitizeQuery';
import { clipFilter, typeFilterFromQuery } from './podcast.constant';
import { typeRuleViolations } from './podcast.validation';
import mediaService, { s3KeyFromUrl } from '../media/media.service';
import { probeVideoDimensions } from '../media/media.probe';
import { errorLogger } from '../../shared/logger';
/** Fields a client may set. Counters, ownership and moderation status are server-controlled. */
const EDITABLE_FIELDS = [
    'category',
    'subCategory',
    'coverImage',
    'podcast_url',
    'mediaType',
    'title',
    'description',
    'location',
    'address',
    'tags',
    'duration',
    'durationSeconds',
    'type',
    'sourcePodcast',
    'videoWidth',
    'videoHeight',
] as const;

const pickEditable = (payload: Partial<IPodcast>) => {
    const clean: Record<string, unknown> = {};
    for (const key of EDITABLE_FIELDS) {
        if (payload[key] !== undefined) clean[key] = payload[key];
    }
    // Keep mediaType in sync when the media file changes.
    if (clean.podcast_url && !clean.mediaType) {
        clean.mediaType = detectMediaType(clean.podcast_url as string);
    }
    return clean as Partial<IPodcast>;
};

/**
 * The Station model calls its field `donationUrl`, while creators (and the apps)
 * use `donationLink`. Expose both on populated stations so the donate button works.
 */
const withStationDonationLink = <T>(podcast: T): T => {
    const station = (podcast as any)?.station;
    if (station && typeof station === 'object' && 'donationUrl' in station) {
        station.donationLink = station.donationUrl;
    }
    return podcast;
};

/** Admin edits must reach hidden podcasts too (e.g. to un-hide them). */
const ADMIN_QUERY = { includeHidden: true };

/** A clip's source must be an existing, visible full episode (not another clip). */
const assertValidSource = async (sourceId: unknown, selfId?: string) => {
    if (!sourceId) return;
    if (selfId && String(sourceId) === selfId) {
        throw new AppError(httpStatus.BAD_REQUEST, 'A clip cannot be its own source');
    }
    const source = await Podcast.findById(sourceId).select('type').lean();
    if (!source) {
        throw new AppError(httpStatus.NOT_FOUND, 'Source podcast not found');
    }
    if (source.type === 'clip') {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'A clip can only link to a full episode'
        );
    }
};

/**
 * Updates are partial, so the episode/clip rules are checked against the record
 * as it will be after the update.
 */
const assertTypeRulesOnUpdate = async (
    existing: Partial<IPodcast> & { _id: unknown },
    payload: Partial<IPodcast>
) => {
    const type = payload.type ?? existing.type ?? 'episode';
    // Turning a clip back into an episode drops its source link.
    if (type === 'episode' && payload.sourcePodcast === undefined) {
        if (existing.sourcePodcast) payload.sourcePodcast = null;
    }
    const merged = {
        type,
        durationSeconds: payload.durationSeconds ?? existing.durationSeconds,
        location: (payload.location ?? existing.location) as never,
        address: payload.address ?? existing.address,
        sourcePodcast:
            payload.sourcePodcast !== undefined
                ? payload.sourcePodcast
                : existing.sourcePodcast,
    };
    const errors = typeRuleViolations({
        ...merged,
        sourcePodcast: merged.sourcePodcast ? String(merged.sourcePodcast) : null,
    });
    if (errors.length) {
        throw new AppError(httpStatus.BAD_REQUEST, errors.join('. '));
    }
    if (payload.sourcePodcast) {
        await assertValidSource(payload.sourcePodcast, String(existing._id));
    }
};

/**
 * Starts converting the podcast's (new) media file and returns the podcast as it
 * now stands. Conversion problems never fail the upload: the original
 * `podcast_url` keeps playing and the failure is recorded on `processing`.
 */
/**
 * Stores the video's display size (rotation applied) when the upload didn't send
 * one, read from the file header in ~100 ms. Apps use it to show portrait clips
 * full-screen and landscape videos uncropped; conversion uses it to pick renditions.
 * MediaConvert would fill it too, but only after the job — and not at all when
 * conversion is off. Never fails the upload.
 */
const fillVideoDims = async <T extends { _id: unknown }>(doc: T): Promise<T> => {
    const d = doc as any;
    if (d.mediaType !== 'video' || d.videoWidth || !d.podcast_url) return doc;
    try {
        const dims = await probeVideoDimensions(d.podcast_url);
        if (!dims) return doc;
        const updated = await Podcast.findOneAndUpdate(
            // Only if the file is unchanged and nobody set a size meanwhile.
            { _id: d._id, podcast_url: d.podcast_url, videoWidth: null },
            { $set: { videoWidth: dims.width, videoHeight: dims.height } },
            { includeHidden: true, new: true } as never
        );
        return (updated as unknown as T) ?? doc;
    } catch (err) {
        errorLogger.error(`Could not read video size for ${d._id}:`, err);
        return doc;
    }
};

const startMediaConversion = async <T extends { _id: unknown }>(input: T) => {
    const doc = await fillVideoDims(input);
    try {
        const updated = await mediaService.startTranscode(String(doc._id), {
            reset: true,
        });
        return (updated as unknown as T) ?? doc;
    } catch (err) {
        errorLogger.error(`Could not start media conversion for ${doc._id}:`, err);
        return doc;
    }
};

/**
 * Fields to clear when the media file is replaced: the old stream, its status,
 * its size (unless the new upload sent one) and an auto-generated poster cover.
 */
const mediaReplacementFields = (
    podcast: { _id: unknown; coverImage?: string | null },
    payload: Partial<IPodcast>
) => {
    const fields: Record<string, unknown> = { hlsUrl: null, processing: null };
    if (payload.videoWidth === undefined) {
        fields.videoWidth = null;
        fields.videoHeight = null;
    }
    const coverKey = s3KeyFromUrl(podcast.coverImage);
    if (!payload.coverImage && coverKey?.startsWith(`media/${podcast._id}/`)) {
        fields.coverImage = null;
    }
    return fields;
};

const createPodcastIntoDB = async (
    userData: JwtPayload,
    rawPayload: IPodcast
) => {
    const payload = pickEditable(rawPayload) as IPodcast;
    const userId = userData.profileId as string;
    const [category, subCategory] = await Promise.all([
        Category.findById(payload.category),
        SubCategory.findById(payload.subCategory),
    ]);

    if (!category || !subCategory) {
        throw new AppError(
            httpStatus.NOT_FOUND,
            !category ? 'Category not found' : 'Sub category not found'
        );
    }

    if (payload.podcast_url) {
        payload.podcast_url = getCloudFrontUrl(payload.podcast_url);
    }

    if (payload.coverImage) {
        payload.coverImage = getCloudFrontUrl(payload.coverImage);
    }

    await assertValidSource(payload.sourcePodcast);

    // Ownership is decided by the server, never by the request body:
    //   superAdmin -> the platform station, creator -> the creator themself.
    if (userData.role == USER_ROLE.superAdmin) {
        const station = await Station.findOne().select('_id').lean();
        if (!station) {
            throw new AppError(
                httpStatus.CONFLICT,
                'The platform station is not set up yet'
            );
        }
        const created = await Podcast.create({
            ...payload,
            station: station._id,
            creator: null,
        });
        return startMediaConversion(created);
    }

    // Creators must be approved before they can publish.
    const creator = await Creator.findById(userId).select('isApproved').lean();
    if (!creator) {
        throw new AppError(httpStatus.NOT_FOUND, 'Creator profile not found');
    }
    if (!creator.isApproved) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'Your creator account is waiting for approval'
        );
    }
    const created = await Podcast.create({
        ...payload,
        creator: userId,
        station: null,
    });
    return startMediaConversion(created);
};

const updatePodcastIntoDB = async (
    userData: JwtPayload,
    id: string,
    rawPayload: Partial<IPodcast>
) => {
    const payload = pickEditable(rawPayload);
    if (userData.role == USER_ROLE.creator) {
        const userId = userData.profileId as string;
        const podcast = await Podcast.findOne({ _id: id, creator: userId });
        if (!podcast) {
            throw new AppError(httpStatus.NOT_FOUND, 'Podcast not found');
        }
        await assertTypeRulesOnUpdate(podcast, payload);

        if (payload.podcast_url) {
            payload.podcast_url = getCloudFrontUrl(payload.podcast_url);
        }
        const mediaChanged = Boolean(
            payload.podcast_url && payload.podcast_url !== podcast.podcast_url
        );

        const reuslt = await Podcast.findByIdAndUpdate(
            id,
            mediaChanged
                ? { ...payload, ...mediaReplacementFields(podcast, payload) }
                : payload,
            { new: true, runValidators: true }
        );

        if (mediaChanged) {
            deleteFileFromS3(podcast?.podcast_url as string);
            mediaService.deleteMediaFolder(id);
        }

        if (payload.coverImage && podcast?.coverImage) {
            deleteFileFromS3(podcast?.coverImage);
        }

        return mediaChanged && reuslt
            ? startMediaConversion(reuslt)
            : reuslt;
    } else {
        const podcast = await Podcast.findOne({
            _id: id,
            // platform-owned: linked to the station, or legacy admin uploads with no creator
            $or: [{ station: { $ne: null } }, { creator: null }],
        }).setOptions(ADMIN_QUERY);
        if (!podcast) {
            throw new AppError(httpStatus.NOT_FOUND, 'Podcast not found');
        }
        await assertTypeRulesOnUpdate(podcast, payload);
        if (payload.podcast_url) {
            payload.podcast_url = getCloudFrontUrl(payload.podcast_url);
        }
        if (payload.coverImage) {
            payload.coverImage = getCloudFrontUrl(payload.coverImage);
        }

        const mediaChanged = Boolean(
            payload.podcast_url && payload.podcast_url !== podcast.podcast_url
        );

        const reuslt = await Podcast.findByIdAndUpdate(
            id,
            mediaChanged
                ? { ...payload, ...mediaReplacementFields(podcast, payload) }
                : payload,
            { new: true, runValidators: true, ...ADMIN_QUERY }
        );

        if (mediaChanged) {
            deleteFileFromS3(podcast?.podcast_url as string);
            mediaService.deleteMediaFolder(id);
        }

        if (payload.coverImage && podcast?.coverImage) {
            deleteFileFromS3(podcast?.coverImage);
        }

        return mediaChanged && reuslt
            ? startMediaConversion(reuslt)
            : reuslt;
    }
};

/**
 * Adds `totalComments` and `totalBookmarks` to each podcast. These aren't stored on
 * the podcast, so they're counted per page with two indexed group queries.
 */
const attachEngagementCounts = async <T extends { _id: any }>(docs: T[]) => {
    if (!docs.length) return docs;
    const ids = docs.map((d) => d._id);
    const countBy = (Model: any) =>
        Model.aggregate([
            { $match: { podcast: { $in: ids } } },
            { $group: { _id: '$podcast', n: { $sum: 1 } } },
        ]).then(
            (rows: { _id: any; n: number }[]) =>
                new Map(rows.map((r) => [String(r._id), r.n]))
        );
    const [comments, bookmarks] = await Promise.all([
        countBy(Comment),
        countBy(Bookmark),
    ]);
    return docs.map((d) =>
        Object.assign(d, {
            totalComments: comments.get(String(d._id)) ?? 0,
            totalBookmarks: bookmarks.get(String(d._id)) ?? 0,
        })
    );
};

const getAllPodcasts = async (
    query: Record<string, any>,
    options: { includeHidden?: boolean } = {}
): Promise<{ meta: any; result: any[] }> => {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);
    const skip = (page - 1) * limit;
    const searchTerm = escapeRegex(query.searchTerm).trim();

    // Podcasts whose category/subcategory document was hard-deleted were always
    // excluded (the old pipeline used a non-preserving $unwind). Keep that, but as
    // an indexed match on the small category collections instead of a join.
    const [categoryIds, subCategoryIds, creatorIds] = await Promise.all([
        Category.distinct('_id'),
        SubCategory.distinct('_id'),
        searchTerm
            ? Creator.find({ name: { $regex: searchTerm, $options: 'i' } })
                  .select('_id')
                  .limit(500)
                  .lean()
                  .then((rows) => rows.map((r) => r._id))
            : Promise.resolve([]),
    ]);

    const match: Record<string, any> = {
        category: { $in: categoryIds },
        subCategory: { $in: subCategoryIds },
    };
    const typeFilter = typeFilterFromQuery(query);
    if (typeFilter) match.$and = [typeFilter];
    if (options.includeHidden && PODCAST_STATUS.includes(query.status)) {
        match.status =
            query.status === 'published' ? { $ne: 'hidden' } : 'hidden';
    }
    if (searchTerm) {
        match.$or = [
            { title: { $regex: searchTerm, $options: 'i' } },
            { description: { $regex: searchTerm, $options: 'i' } },
            ...(creatorIds.length ? [{ creator: { $in: creatorIds } }] : []),
        ];
    }

    // Filter → sort → page on the podcast's own (indexed) fields first, then join
    // only the documents on this page (plain $lookup: works on every MongoDB
    // version). Previously every podcast in the collection
    // was joined with four other collections on every request.
    // `?sort=popular` → most viewed first (home "Faith Hits"); default newest
    // first. Both end on `_id` so pages are stable when values tie.
    const sortStage: Record<string, 1 | -1> =
        query.sort === 'popular'
            ? { totalView: -1, createdAt: -1, _id: -1 }
            : { createdAt: -1, _id: -1 };

    const pagePipeline: PipelineStage[] = [
        { $match: match },
        { $sort: sortStage },
        { $skip: skip },
        { $limit: limit },
        {
            $lookup: {
                from: 'creators',
                localField: 'creator',
                foreignField: '_id',
                as: 'creator',
            },
        },
        { $unwind: { path: '$creator', preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: 'categories',
                localField: 'category',
                foreignField: '_id',
                as: 'category',
            },
        },
        { $unwind: '$category' },
        {
            $lookup: {
                from: 'subcategories',
                localField: 'subCategory',
                foreignField: '_id',
                as: 'subCategory',
            },
        },
        { $unwind: '$subCategory' },
        {
            $lookup: {
                from: 'stations',
                localField: 'station',
                foreignField: '_id',
                as: 'station',
            },
        },
        { $unwind: { path: '$station', preserveNullAndEmptyArrays: true } },
        {
            $project: {
                title: 1,
                description: 1,
                coverImage: 1,
                podcast_url: 1,
                hlsUrl: 1,
                'processing.status': 1,
                videoWidth: 1,
                videoHeight: 1,
                mediaType: 1,
                status: 1,
                address: 1,
                tags: 1,
                totalView: 1,
                totalLikes: 1,
                duration: 1,
                durationSeconds: 1,
                type: 1,
                sourcePodcast: 1,
                createdAt: 1,
                updatedAt: 1,
                location: 1,
                category: { _id: 1, name: 1 },
                subCategory: { _id: 1, name: 1 },
                station: { _id: 1, name: 1, profile_image: 1 },
                creator: {
                    _id: 1,
                    name: 1,
                    profile_image: 1,
                    donationLink: 1,
                },
            },
        },
    ];

    const aggregateOptions = { includeHidden: options.includeHidden } as never;
    const [total, result] = await Promise.all([
        Podcast.countDocuments(match).setOptions({
            includeHidden: options.includeHidden,
        }),
        Podcast.aggregate(pagePipeline).option(aggregateOptions),
    ]);

    return {
        meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
        result: await attachEngagementCounts(result),
    };
};
const getMyPodcasts = async (
    userData: JwtPayload,
    query: Record<string, unknown>
) => {
    if (userData.role == USER_ROLE.creator) {
        const profileId = userData.profileId;
        const cacheKey = `user:${profileId}:${createCacheKey(query)}`;

        // 1. Try to get cached data from Redis
        const cachedData = await redis.get(cacheKey);
        if (cachedData) {
            // Cache hit - parse and return
            return JSON.parse(cachedData);
        }

        // Filters live under $and: QueryBuilder.search() adds its own $or, which
        // would overwrite a top-level $or.
        const filterQuery: any = { $and: [] };
        const typeFilter = typeFilterFromQuery(query);
        if (typeFilter) filterQuery.$and.push(typeFilter);
        delete query.reels;
        delete query.type;

        if (query.popular) {
            query.sort = '-totalView';
            delete query.popular;
        }

        const resultQuery = new QueryBuilder(
            Podcast.find({
                ...(filterQuery.$and.length ? filterQuery : {}),
                creator: profileId,
            }).populate([
                { path: 'creator', select: 'name profile_image' },
                { path: 'category', select: 'name' },
                { path: 'subCategory', select: 'name' },
            ]),
            query
        )
            .search(['name', 'title', 'description'])
            .fields()
            .filter()
            .paginate()
            .sort();

        const result = await resultQuery.modelQuery;
        const meta = await resultQuery.countTotal();
        const dataToCache = { meta, result };

        // 3. Store result in Redis cache with TTL
        await redis.set(
            cacheKey,
            JSON.stringify(dataToCache),
            'EX',
            CACHE_TTL_SECONDS
        );

        return dataToCache;
    } else {
        // Filters live under $and: QueryBuilder.search() adds its own $or, which
        // would overwrite a top-level $or.
        const filterQuery: any = { $and: [] };
        const typeFilter = typeFilterFromQuery(query);
        if (typeFilter) filterQuery.$and.push(typeFilter);
        delete query.reels;
        delete query.type;

        if (query.popular) {
            query.sort = '-totalView';
            delete query.popular;
        }

        const resultQuery = new QueryBuilder(
            Podcast.find({
                ...filterQuery,
                $and: [
                    ...filterQuery.$and,
                    // platform podcasts: linked to the station, or legacy admin uploads
                    { $or: [{ station: { $ne: null } }, { creator: null }] },
                ],
            }).populate([
                // { path: 'creator', select: 'name profile_image' },
                { path: 'station', select: 'name profile_image donationUrl' },
                { path: 'category', select: 'name' },
                { path: 'subCategory', select: 'name' },
            ]),
            query
        )
            .search(['name', 'title', 'description'])
            .fields()
            .filter()
            .paginate()
            .sort();

        const result = (await resultQuery.modelQuery.lean()).map(
            withStationDonationLink
        );
        const meta = await resultQuery.countTotal();
        const dataToCache = { meta, result };

        return dataToCache;
    }
};

// for randomize ===================================

export const getPodcastFeedForUser = async (
    userId: string,
    query: Record<string, unknown>
) => {
    const limit = Math.min(Number(query.limit) || 20, 50);
    const firstPodcastId = query.firstPodcastId as string;
    const lastId = query.lastId as string | undefined; // for smooth scroll

    if (!firstPodcastId) throw new Error('firstPodcastId is required');

    // Step 0: Cache bookmarks & likes
    const [cachedBookmarks, cachedLikes] = await Promise.all([
        redis.get(`bookmarks:${userId}`),
        redis.get(`likes:${userId}`),
    ]);

    const bookmarkedPodcastIds = cachedBookmarks
        ? new Set(JSON.parse(cachedBookmarks))
        : new Set(
            (
                await Bookmark.find({ user: userId }).select('podcast').lean()
            ).map((b) => b.podcast.toString())
        );

    const likedPodcastIds = cachedLikes
        ? new Set(JSON.parse(cachedLikes))
        : new Set(
            (
                await Like.find({ user: userId }).select('podcast').lean()
            ).map((l) => l.podcast.toString())
        );

    // Update Redis if empty
    if (!cachedBookmarks) {
        await redis.set(
            `bookmarks:${userId}`,
            JSON.stringify([...bookmarkedPodcastIds]),
            'EX',
            600
        );
    }
    if (!cachedLikes) {
        await redis.set(
            `likes:${userId}`,
            JSON.stringify([...likedPodcastIds]),
            'EX',
            600
        );
    }

    // Step 1: Fetch first podcast
    const firstPodcast = await Podcast.findById(firstPodcastId)
        .populate('category', 'name')
        .populate('subCategory', 'name')
        .populate('creator', 'name donationLink profile_image')
        .populate('station', 'name profile_image donationUrl')
        .lean();

    if (!firstPodcast) throw new Error('First podcast not found');
    withStationDonationLink(firstPodcast);

    // Step 2: Aggregate podcasts
    const buildFeedPipeline = (cursor?: string): mongoose.PipelineStage[] => [
        {
            $match: {
                _id: { $ne: new mongoose.Types.ObjectId(firstPodcastId) },
                ...(cursor
                    ? { _id: { $lt: new mongoose.Types.ObjectId(cursor) } }
                    : {}),
            },
        },
        {
            $facet: {
                categoryPodcasts: [
                    {
                        $match: {
                            category: firstPodcast.category._id,
                            // subCategory: firstPodcast.subCategory._id, //TODO: need to work if want also match sub category
                        },
                    },
                    { $sample: { size: limit } },
                ],
                fallbackPodcasts: [
                    { $sample: { size: limit } }, // random fallback
                ],
            },
        },
        {
            $project: {
                podcasts: {
                    $concatArrays: [
                        '$categoryPodcasts',
                        {
                            $slice: [
                                '$fallbackPodcasts',
                                {
                                    $subtract: [
                                        limit,
                                        { $size: '$categoryPodcasts' },
                                    ],
                                },
                                limit,
                            ],
                        },
                    ],
                },
            },
        },
        { $unwind: '$podcasts' },
        { $replaceRoot: { newRoot: '$podcasts' } },
        {
            $lookup: {
                from: 'users',
                localField: 'creator',
                foreignField: '_id',
                as: 'creator',
            },
        },
        { $unwind: { path: '$creator', preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: 'stations',
                localField: 'station',
                foreignField: '_id',
                as: 'station',
            },
        },
        { $unwind: { path: '$station', preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: 'categories',
                localField: 'category',
                foreignField: '_id',
                as: 'category',
            },
        },
        { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: 'subcategories',
                localField: 'subCategory',
                foreignField: '_id',
                as: 'subCategory',
            },
        },
        { $unwind: { path: '$subCategory', preserveNullAndEmptyArrays: true } },
        {
            $project: {
                title: 1,
                coverImage: 1,
                podcast_url: 1,
                hlsUrl: 1,
                'processing.status': 1,
                videoWidth: 1,
                videoHeight: 1,
                category: { name: 1 },
                subCategory: { name: 1 },
                location: 1,
                duration: 1,
                durationSeconds: 1,
                type: 1,
                mediaType: 1,
                sourcePodcast: 1,
                createdAt: 1,
                creator: { name: 1, donationLink: 1, profile_image: 1 },
                // Station stores `donationUrl`; expose it as `donationLink` like
                // creators. $$REMOVE keeps `station` absent for creator podcasts.
                station: {
                    $cond: [
                        { $ifNull: ['$station._id', false] },
                        {
                            _id: '$station._id',
                            name: '$station.name',
                            profile_image: '$station.profile_image',
                            donationLink: '$station.donationUrl',
                        },
                        '$$REMOVE',
                    ],
                },
            },
        },
        { $limit: limit },
    ];

    let podcastsAgg = await Podcast.aggregate(buildFeedPipeline(lastId));

    // When the cursor is exhausted, sample from the full podcast collection again.
    if (podcastsAgg.length === 0 && lastId) {
        podcastsAgg = await Podcast.aggregate(buildFeedPipeline());
    }

    // Step 3: Ensure always data is returned
    if (podcastsAgg.length === 0) {
        podcastsAgg = Array(limit).fill(firstPodcast); // repeat first podcast if empty
    }

    // Step 4: Prepend first podcast if first page
    const podcasts = !lastId
        ? [
            firstPodcast,
            ...podcastsAgg.filter(
                (p) => p._id.toString() !== firstPodcast._id.toString()
            ),
        ]
        : podcastsAgg;

    // Step 5: Add flags
    const podcastsWithFlags = podcasts.map((p) => ({
        ...p,
        isBookmark: bookmarkedPodcastIds.has(p._id.toString()),
        isLike: likedPodcastIds.has(p._id.toString()),
    }));

    // Step 6: Prepare next cursor
    const nextCursor = podcastsWithFlags.length
        ? podcastsWithFlags[podcastsWithFlags.length - 1]._id
        : null;

    return {
        podcasts: podcastsWithFlags,
        nextCursor,
        hasMore: true, // endless scroll
    };
};

const getSinglePodcast = async (id: string, viewer?: JwtPayload | null) => {
    const isAdmin = viewer?.role === USER_ROLE.superAdmin;
    const podcast = await Podcast.findById(id)
        .setOptions({ includeHidden: isAdmin })
        .populate([
            {
                path: 'creator',
                select: 'name profile_image',
            },
            {
                path: 'station',
                select: 'name profile_image donationUrl',
            },
            {
                path: 'category',
                select: 'name',
            },
            {
                path: 'subCategory',
                select: 'name',
            },
            {
                // "Watch full message" for clips; null if hidden/deleted.
                path: 'sourcePodcast',
                select: 'title coverImage mediaType duration durationSeconds',
            },
        ])
        // Legacy embedded array (removed by the likes migration) — never expose
        // the full list of users who liked a podcast.
        .select('-likers')
        .lean();
    if (!podcast) {
        throw new AppError(httpStatus.NOT_FOUND, 'Podcast not found');
    }

    // Personalised fields when the caller is signed in.
    let isLike = false;
    let isBookmark = false;
    const profileId = viewer?.profileId;
    if (profileId && mongoose.isValidObjectId(profileId)) {
        const [like, bookmark] = await Promise.all([
            Like.exists({ podcast: podcast._id, user: profileId }),
            Bookmark.exists({ podcast: podcast._id, user: profileId }),
        ]);
        isLike = Boolean(like);
        isBookmark = Boolean(bookmark);
    }

    withStationDonationLink(podcast);
    await attachEngagementCounts([podcast]);
    // Job ids and AWS error text are for admins; apps only need the status.
    if (!isAdmin && podcast.processing) {
        podcast.processing = { status: podcast.processing.status };
    }
    return {
        ...podcast,
        isLike,
        isBookmark,
        // Backward compatibility: older app builds derive "liked" from
        // `likers.some(l => l.user === me)`. Only the viewer's own entry is
        // returned, so that check keeps working without leaking other users.
        likers: isLike
            ? [
                  {
                      user: profileId,
                      userType:
                          viewer?.role === USER_ROLE.creator
                              ? 'Creator'
                              : 'NormalUser',
                  },
              ]
            : [],
    };
};

const deletePodcastFromDB = async (userData: JwtPayload, id: string) => {
    if (userData.role == USER_ROLE.creator) {
        const userId = userData.profileId as string;
        const podcast = await Podcast.findOne({ _id: id, creator: userId });
        if (!podcast) {
            throw new AppError(httpStatus.NOT_FOUND, 'Podcast not found');
        }
        if (podcast.podcast_url) {
            const podcastUrl = getCloudFrontUrl(podcast.podcast_url);
            deleteFileFromS3(podcastUrl);
        }
        if (podcast.coverImage) {
            const coverImageUrl = getCloudFrontUrl(podcast.coverImage);
            deleteFileFromS3(coverImageUrl);
        }
        const deleted = await Podcast.findByIdAndDelete(id, ADMIN_QUERY);
        await Promise.all([
            Album.updateMany({ podcasts: id }, { $pull: { podcasts: id } }),
            playlistService.pullPodcastsFromPlaylists([id]),
            Like.deleteMany({ podcast: id }),
            Bookmark.deleteMany({ podcast: id }),
            Comment.deleteMany({ podcast: id }),
        ]);
        mediaService.deleteMediaFolder(id);
        return deleted;
    } else {
        const podcast = await Podcast.findOne({
            _id: id,
            $or: [{ station: { $ne: null } }, { creator: null }],
        }).setOptions(ADMIN_QUERY);
        if (!podcast) {
            throw new AppError(httpStatus.NOT_FOUND, 'Podcast not found');
        }
        if (podcast.podcast_url) {
            const podcastUrl = getCloudFrontUrl(podcast.podcast_url);
            deleteFileFromS3(podcastUrl);
        }
        if (podcast.coverImage) {
            const coverImageUrl = getCloudFrontUrl(podcast.coverImage);
            deleteFileFromS3(coverImageUrl);
        }
        const deleted = await Podcast.findByIdAndDelete(id, ADMIN_QUERY);
        await Promise.all([
            Album.updateMany({ podcasts: id }, { $pull: { podcasts: id } }),
            playlistService.pullPodcastsFromPlaylists([id]),
            Like.deleteMany({ podcast: id }),
            Bookmark.deleteMany({ podcast: id }),
            Comment.deleteMany({ podcast: id }),
        ]);
        mediaService.deleteMediaFolder(id);
        return deleted;
    }
};

const countPodcastView = async (profileId: string, podcastId: string) => {
    await Podcast.findByIdAndUpdate(podcastId, { $inc: { totalView: 1 } });

    await WatchHistory.findOneAndUpdate(
        { user: profileId, podcast: podcastId },
        { $set: { updatedAt: new Date() } },
        { upsert: true, new: true }
    );

    return null;
};

const getHomeData = async () => {
    const cacheKey = 'home:data';

    // 1. Try to get cached data
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
        return JSON.parse(cachedData);
    }
    const [
        categories,
        newestPodcasts,
        popularPodcasts,
        reels,
        albums,
        topCreators,
    ] = await Promise.all([
        Category.find().limit(10).lean(),
        Podcast.find()
            .populate({ path: 'category', select: 'name' })
            .populate('subCategory', 'name')
            .populate('creator', 'name profile_image')
            .populate('station', 'name profile_image')
            .sort({ createdAt: -1 })
            .limit(10)
            .lean(),
        Podcast.find()
            .populate({ path: 'category', select: 'name' })
            .populate('subCategory', 'name')
            .populate('creator', 'name profile_image')
            .populate('station', 'name profile_image')
            .sort({ totalView: -1 })
            .limit(10)
            .lean(),
        // Home "Preach Clips" row (legacy records: previous 120 rule)
        Podcast.find(clipFilter(120))
            .populate({ path: 'category', select: 'name' })
            .populate('subCategory', 'name')
            .populate('creator', 'name profile_image')
            .populate('station', 'name profile_image')
            .sort({ createdAt: -1 })
            .limit(10)
            .lean(),
        Album.find().sort({ updatedAt: -1 }).limit(10).lean(),

        Creator.aggregate([
            // Lookup active live session
            {
                $lookup: {
                    from: 'livesessions',
                    let: { creatorId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$creator', '$$creatorId'] },
                                        { $eq: ['$status', 'active'] }, // ENUM_LIVE_SESSION.ACTIVE
                                    ],
                                },
                            },
                        },
                    ],
                    as: 'liveSession',
                },
            },
            {
                $addFields: {
                    isLive: { $gt: [{ $size: '$liveSession' }, 0] },
                    liveSession: { $arrayElemAt: ['$liveSession', 0] },
                },
            },

            // Lookup stream room if live
            {
                $lookup: {
                    from: 'streamrooms',
                    localField: 'liveSession.streamRoom',
                    foreignField: '_id',
                    as: 'streamRoom',
                },
            },
            {
                $unwind: {
                    path: '$streamRoom',
                    preserveNullAndEmptyArrays: true,
                },
            },

            // Lookup podcasts for total views
            {
                $lookup: {
                    from: 'podcasts',
                    localField: '_id',
                    foreignField: 'creator',
                    as: 'creatorPodcasts',
                },
            },
            {
                $addFields: {
                    totalViews: { $sum: '$creatorPodcasts.totalView' },
                    latestPodcast: {
                        $arrayElemAt: [
                            {
                                $sortArray: {
                                    input: '$creatorPodcasts',
                                    sortBy: { createdAt: -1 },
                                },
                            },
                            0,
                        ],
                    },
                },
            },

            // Sort: live first, then by totalViews
            {
                $sort: { isLive: -1, totalViews: -1 },
            },

            // Select fields
            {
                $project: {
                    // _id: 0,
                    creatorId: '$_id',
                    name: 1,
                    email: 1,
                    profile_image: 1,
                    profile_cover: 1,
                    phone: 1,
                    location: 1,
                    donationLink: 1,
                    isLive: 1,
                    totalViews: 1,
                    liveSession: {
                        session_id: '$liveSession.session_id',
                        name: '$liveSession.name',
                        description: '$liveSession.description',
                        coverImage: '$liveSession.coverImage',
                        session_started_at: '$liveSession.session_started_at',
                        duration: '$liveSession.duration',
                    },
                    streamRoom: 1,
                    latestPodcast: {
                        _id: '$latestPodcast._id',
                        title: '$latestPodcast.title',
                        description: '$latestPodcast.description',
                        podcast_url: '$latestPodcast.podcast_url',
                        hlsUrl: '$latestPodcast.hlsUrl',
                        coverImage: '$latestPodcast.coverImage',
                    },
                },
            },

            // Pagination
            {
                $limit: 10,
            },
        ]),
    ]);
    const response = {
        categories,
        newestPodcasts,
        popularPodcasts,
        reels,
        albums,
        topCreators,
    };

    await redis.set(cacheKey, JSON.stringify(response), 'EX', 60 * 60);

    return {
        categories,
        newestPodcasts,
        popularPodcasts,
        reels,
        albums,
        topCreators,
    };
};

const getPodcastForSubcategories = async (categoryId: string) => {
    const cacheKey = `subcat-podcast:${categoryId}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
        return JSON.parse(cached);
    }

    console.log('Fetching from DB for subcategories podcasts');

    const result = await SubCategory.aggregate([
        {
            $match: {
                category: new mongoose.Types.ObjectId(categoryId),
                isDeleted: false,
            },
        },
        {
            $lookup: {
                from: 'podcasts',
                let: {
                    subCatId: '$_id',
                    categoryId: '$category',
                },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $eq: ['$subCategory', '$$subCatId'] },
                                    { $eq: ['$category', '$$categoryId'] },
                                ],
                            },
                        },
                    },
                    { $sort: { createdAt: -1 } },
                    { $limit: 10 },
                    // Lookup for creator
                    {
                        $lookup: {
                            from: 'creators',
                            localField: 'creator',
                            foreignField: '_id',
                            as: 'creator',
                        },
                    },
                    {
                        $unwind: {
                            path: '$creator',
                            preserveNullAndEmptyArrays: true,
                        },
                    },
                    // Lookup for category
                    {
                        $lookup: {
                            from: 'categories',
                            localField: 'category',
                            foreignField: '_id',
                            as: 'category',
                        },
                    },
                    {
                        $unwind: '$category',
                    },
                    // Lookup for subCategory
                    {
                        $lookup: {
                            from: 'subcategories',
                            localField: 'subCategory',
                            foreignField: '_id',
                            as: 'subCategory',
                        },
                    },
                    {
                        $unwind: '$subCategory',
                    },
                    {
                        $project: {
                            title: 1,
                            coverImage: 1,
                            podcast_url: 1,
                            hlsUrl: 1,
                            'processing.status': 1,
                            videoWidth: 1,
                            videoHeight: 1,
                            duration: 1,
                            createdAt: 1,
                            location: 1,
                            'creator._id': 1,
                            'creator.name': 1,
                            'category._id': 1,
                            'category.name': 1,
                            'subCategory._id': 1,
                            'subCategory.name': 1,
                        },
                    },
                ],
                as: 'podcasts',
            },
        },
        {
            $project: {
                _id: 1,
                name: 1,
                image: 1,
                podcasts: 1,
            },
        },
    ]);

    // 3. Cache result in Redis (expire in 5 minutes)
    await redis.set(cacheKey, JSON.stringify(result), 'EX', 300);

    return result;
};

const toggleLikePodcast = async (podcastId: string, userData: JwtPayload) => {
    const profileId = userData.profileId as string;
    if (!mongoose.isValidObjectId(podcastId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid podcast id');
    }
    const userType =
        userData.role == USER_ROLE.creator ? 'Creator' : 'NormalUser';
    const podcastObjectId = new mongoose.Types.ObjectId(podcastId);
    const userObjectId = new mongoose.Types.ObjectId(profileId);

    const exists = await Podcast.exists({ _id: podcastObjectId });
    if (!exists) {
        throw new AppError(httpStatus.NOT_FOUND, 'Podcast not found');
    }

    // Unlike: a single atomic delete tells us whether a like existed.
    const removed = await Like.deleteOne({
        podcast: podcastObjectId,
        user: userObjectId,
    });

    let isLike: boolean;
    if (removed.deletedCount === 1) {
        await Podcast.updateOne(
            { _id: podcastObjectId, totalLikes: { $gt: 0 } },
            { $inc: { totalLikes: -1 } }
        );
        isLike = false;
    } else {
        // Transitional: a like stored in the legacy embedded array (before the
        // likes migration has run) is still an existing like -> unlike it.
        const legacy = await Podcast.collection.updateOne(
            { _id: podcastObjectId, 'likers.user': userObjectId },
            {
                $pull: { likers: { user: userObjectId } },
                $inc: { totalLikes: -1 },
            } as never
        );
        if (legacy.modifiedCount === 1) {
            isLike = false;
        } else {
            try {
                await Like.create({
                    podcast: podcastObjectId,
                    user: userObjectId,
                    userType,
                });
                await Podcast.updateOne(
                    { _id: podcastObjectId },
                    { $inc: { totalLikes: 1 } }
                );
            } catch (err: any) {
                // Duplicate key: a concurrent request already liked it. The end
                // state (liked) is what the user asked for, and the counter was
                // incremented exactly once by the request that won.
                if (err?.code !== 11000) throw err;
            }
            isLike = true;
        }
    }

    // The feed caches each user's liked ids for 10 minutes.
    await deleteKeys(userCacheKeys.likes(profileId));
    return { isLike };
};

/**
 * Deletes every podcast owned by a creator (files, likes, bookmarks, comments, album and playlist refs).
 * Called when a creator account is deleted or rejected: otherwise their podcasts
 * stay public with a dangling `creator` reference that nobody can edit or delete.
 */
const deleteAllPodcastsOfCreator = async (creatorId: string) => {
    const podcasts = await Podcast.find({ creator: creatorId })
        .setOptions(ADMIN_QUERY)
        .select('podcast_url coverImage')
        .lean();
    if (!podcasts.length) return 0;
    const ids = podcasts.map((p) => p._id);

    await Promise.all([
        Podcast.deleteMany({ _id: { $in: ids } }),
        Like.deleteMany({ podcast: { $in: ids } }),
        Bookmark.deleteMany({ podcast: { $in: ids } }),
        Comment.deleteMany({ podcast: { $in: ids } }),
        Album.updateMany(
            { podcasts: { $in: ids } },
            { $pull: { podcasts: { $in: ids } } }
        ),
        playlistService.pullPodcastsFromPlaylists(ids),
    ]);
    // File cleanup is best-effort and must not block the account deletion.
    podcasts.forEach((p) => {
        if (p.podcast_url) deleteFileFromS3(getCloudFrontUrl(p.podcast_url));
        if (p.coverImage) deleteFileFromS3(getCloudFrontUrl(p.coverImage));
        mediaService.deleteMediaFolder(String(p._id));
    });
    await deleteKeys('home:data');
    return podcasts.length;
};

/** Admin moderation: hide a podcast from the apps without deleting it. */
const setPodcastStatus = async (id: string, status: TPodcastStatus) => {
    const result = await Podcast.findByIdAndUpdate(
        id,
        { status },
        { new: true, runValidators: true, ...ADMIN_QUERY }
    );
    if (!result) throw new AppError(httpStatus.NOT_FOUND, 'Podcast not found');
    return result;
};

const globalSearch = async (params: any) => {
    const { searchTerm, lat, lng, page = 1, limit = 10 } = params;

    if (!searchTerm?.trim()) {
        return getDefaultFeed(params);
    }

    return searchWithKeyword({
        searchTerm,
        page,
        limit,
        lat,
        lng,
    });
};

const searchWithKeyword = async ({
    searchTerm,
    page,
    limit,
    lat,
    lng,
}: {
    searchTerm: string;
    page: number;
    limit: number;
    lat?: number;
    lng?: number;
}) => {
    const skip = (page - 1) * limit;

    const hasLocation = lat && lng;

    const pipeline: any[] = [];

    // 🔥 GEO SEARCH FIRST (if provided)
    if (hasLocation) {
        pipeline.push({
            $geoNear: {
                near: {
                    type: 'Point',
                    coordinates: [lng, lat], // ⚠️ lng first
                },
                distanceField: 'distance',
                spherical: true,
                query: searchTerm ? { $text: { $search: searchTerm } } : {},
            },
        });
    } else if (searchTerm) {
        pipeline.push({
            $match: {
                $text: { $search: searchTerm },
            },
        });

        pipeline.push({
            $addFields: {
                score: { $meta: 'textScore' },
            },
        });
    }

    // 🔥 Common fields
    pipeline.push(
        {
            $addFields: {
                type: 'podcast',
            },
        },
        {
            $project: {
                _id: 1,
                title: 1,
                image: '$coverImage',
                createdAt: 1,
                score: hasLocation ? 0 : '$score',
                distance: 1,
                type: 1,
            },
        }
    );

    // 🔥 UNION WITH CREATORS (no geo for now or optional)
    pipeline.push({
        $unionWith: {
            coll: 'creators',
            pipeline: [
                {
                    $match: {
                        isApproved: true,
                        ...(searchTerm && {
                            $text: { $search: searchTerm },
                        }),
                    },
                },
                {
                    $addFields: {
                        type: 'creator',
                        score: searchTerm ? { $meta: 'textScore' } : 0,
                    },
                },
                {
                    $project: {
                        _id: 1,
                        name: 1,
                        image: '$profile_image',
                        createdAt: 1,
                        score: 1,
                        type: 1,
                    },
                },
            ],
        },
    });

    pipeline.push({
        $sort: hasLocation
            ? { distance: 1, createdAt: -1 } // nearest first
            : { score: -1, createdAt: -1 }, // relevance first
    });

    pipeline.push({
        $facet: {
            data: [{ $skip: skip }, { $limit: Number(limit) }],
            total: [{ $count: 'count' }],
        },
    });

    const result = await Podcast.aggregate(pipeline);

    const data = result[0]?.data || [];
    const total = result[0]?.total[0]?.count || 0;

    return {
        meta: {
            page: Number(page),
            limit: Number(limit),
            total,
            totalPages: Math.ceil(total / limit),
        },
        data: data.map((item: any) => ({
            id: item._id,
            type: item.type,
            title: item.title || null,
            name: item.name || null,
            image: item.image,
            distance: item.distance || null,
        })),
    };
};
const getDefaultFeed = async ({
    page,
    limit,
}: {
    page: number;
    limit: number;
}) => {
    const skip = (page - 1) * limit;

    const [podcasts, creators, podcastCount, creatorCount] = await Promise.all([
        Podcast.find({})
            .sort({ totalView: -1, createdAt: -1, totalLikes: -1 })
            .select('title coverImage totalView createdAt totalLikes')
            .skip(skip)
            .limit(limit)
            .lean(),

        Creator.find({ isApproved: true })
            .sort({ createdAt: -1 })
            .select('name profile_image createdAt')
            .skip(skip)
            .limit(limit)
            .lean(),

        Podcast.countDocuments(),
        Creator.countDocuments({ isApproved: true }),
    ]);

    // normalize
    const combined = [
        ...podcasts.map((p) => ({
            id: p._id,
            type: 'podcast',
            title: p.title,
            image: p.coverImage,
            createdAt: p.createdAt,
            score: p.totalView || 0, // fake score for sorting
        })),
        ...creators.map((c) => ({
            id: c._id,
            type: 'creator',
            name: c.name,
            image: c.profile_image,
            createdAt: c.createdAt,
            score: 0,
        })),
    ];

    //  sorting
    combined.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
    });

    const paginated = combined.slice(0, limit);

    const total = podcastCount + creatorCount;

    return {
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
        data: paginated,
    };
};
const podcastService = {
    createPodcastIntoDB,
    updatePodcastIntoDB,
    getAllPodcasts,
    getSinglePodcast,
    deletePodcastFromDB,
    countPodcastView,
    getHomeData,
    getPodcastFeedForUser,
    getPodcastForSubcategories,
    getMyPodcasts,
    toggleLikePodcast,
    setPodcastStatus,
    deleteAllPodcastsOfCreator,
    globalSearch,
};

export default podcastService;
