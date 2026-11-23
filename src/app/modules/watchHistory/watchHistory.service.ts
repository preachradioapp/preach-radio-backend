import QueryBuilder from '../../builder/QueryBuilder';
import WatchHistory from './watchHistory.model';
import cron from 'node-cron';
const getWatchedHistory = async (
    profileId: string,
    query: Record<string, unknown>
) => {
    // A replay bumps `updatedAt` (see countPodcastView), so "last played" is
    // `updatedAt`. Older apps that send no sort keep the previous order.
    const resultQuery = new QueryBuilder(
        WatchHistory.find({ user: profileId })
            .lean()
            .populate({
                path: 'podcast',
                // type / mediaType / durationSeconds let the app tell clips from
                // episodes and video from audio; station is the owner of platform podcasts.
                select: 'title name coverImage description duration durationSeconds podcast_url hlsUrl processing.status videoWidth videoHeight mediaType type creator station subCategory category address location tags totalView totalLikes createdAt',
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
        .search(['name', 'title', 'description'])
        .fields()
        .filter()
        .paginate()
        .sort();
    const result = await resultQuery.modelQuery;
    const meta = await resultQuery.countTotal();

    return {
        meta,
        result,
    };
};

// Runs every Sunday at 2:00 AM
cron.schedule('0 2 * * 0', async () => {
    try {
        console.log('⏳ Cleaning up old watch history...');

        const uniqueUsers = await WatchHistory.distinct('user');

        for (const userId of uniqueUsers) {
            // Keep the 50 most recently *played* (a replay bumps updatedAt).
            const latestEntries = await WatchHistory.find({ user: userId })
                .sort({ updatedAt: -1 })
                .limit(50)
                .select('_id');

            const latestIds = latestEntries.map((entry) => entry._id);

            await WatchHistory.deleteMany({
                user: userId,
                _id: { $nin: latestIds },
            });

            console.log(` Cleaned history for user ${userId}`);
        }

        console.log(' Watch history cleanup completed.');
    } catch (error) {
        console.error('Error cleaning watch history:', error);
    }
});

const WatchHistoryServices = { getWatchedHistory };
export default WatchHistoryServices;
