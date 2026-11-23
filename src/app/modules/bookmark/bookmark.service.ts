import httpStatus from 'http-status';
import AppError from '../../error/appError';
import Podcast from '../podcast/podcast.model';
import Bookmark from './bookmark.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { deleteKeys, userCacheKeys } from '../../utilities/cache';

const bookmarkAddDelete = async (profileId: string, podcastId: string) => {
    const podcast = await Podcast.exists({ _id: podcastId });
    if (!podcast) {
        throw new AppError(httpStatus.NOT_FOUND, 'Podcast not found');
    }
    // One atomic delete tells us whether the bookmark existed.
    const removed = await Bookmark.findOneAndDelete({
        user: profileId,
        podcast: podcastId,
    });
    const result = removed
        ? null
        : await Bookmark.create({ user: profileId, podcast: podcastId });

    // The podcast feed caches each user's bookmarked ids for 10 minutes.
    await deleteKeys(userCacheKeys.bookmarks(profileId));
    return result;
};

// get bookmark from db
const getMyBookmarkFromDB = async (
    profileId: string,
    query: Record<string, unknown>
) => {
    const resultQuery = new QueryBuilder(
        Bookmark.find({ user: profileId }).populate({
            path: 'podcast',
            // Everything the app needs to show and play it (same fields as watch history).
            select: 'title description coverImage duration durationSeconds podcast_url hlsUrl processing.status videoWidth videoHeight mediaType type creator station subCategory category tags totalView totalLikes createdAt',
            populate: [
                {
                    path: 'category',
                    select: 'name',
                },
                {
                    path: 'subCategory',
                    select: 'name',
                },
                {
                    path: 'creator',
                    select: 'name profile_image',
                },
                {
                    path: 'station',
                    select: 'name profile_image',
                },
            ],
        }),
        query
    )
        .search(['name', 'email'])
        .fields()
        .filter()
        .paginate()
        .sort();
    const result = await resultQuery.modelQuery;
    const meta = await resultQuery.countTotal();
    return { meta, result };
};

const BookmarkService = {
    bookmarkAddDelete,
    getMyBookmarkFromDB,
};

export default BookmarkService;
