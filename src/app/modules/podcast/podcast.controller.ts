/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import generateETag from '../../helper/generateEtag';
import { getCloudFrontUrl } from '../../helper/mutler-s3-uploader';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import podcastService from './podcast.service';
import { USER_ROLE } from '../user/user.constant';

const createPodcast = catchAsync(async (req, res) => {
    const result = await podcastService.createPodcastIntoDB(req.user, req.body);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Podcast created successfully',
        data: result,
    });
});

const updatePodcast = catchAsync(async (req, res) => {
    const file: any = req.files?.podcast_cover;
    if (file) {
        req.body.coverImage = getCloudFrontUrl(file[0].key);
    }
    const result = await podcastService.updatePodcastIntoDB(
        req.user,
        req.params.id,
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Podcast updated successfully',
        data: result,
    });
});

const getAllPodcasts = catchAsync(async (req, res) => {
    // Admins may include hidden podcasts (dashboard moderation view).
    const includeHidden =
        req.user?.role === USER_ROLE.superAdmin &&
        req.query.includeHidden === 'true';
    const result = await podcastService.getAllPodcasts(req.query, {
        includeHidden,
    });
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Podcasts retrieved successfully',
        data: result,
    });
});

const getMyPodcasts = catchAsync(async (req, res) => {
    // Must be the whole JWT payload: the service branches on `role`. Passing only
    // the profile id meant creators always received the station's podcasts.
    const result = await podcastService.getMyPodcasts(req.user, req.query);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Podcasts retrieved successfully',
        data: result,
    });
});

const getPodcastFeedForUser = catchAsync(async (req, res) => {
    const result = await podcastService.getPodcastFeedForUser(
        req.user.profileId,
        req.query
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Podcasts retrieved successfully',
        data: result,
    });
});

const getSinglePodcast = catchAsync(async (req, res) => {
    const result = await podcastService.getSinglePodcast(
        req.params.id,
        req.user
    );
    // Signed-in responses contain personal fields (isLike/isBookmark): they
    // must never be stored by shared caches/CDNs.
    res.setHeader(
        'Cache-Control',
        req.user
            ? 'private, max-age=0, must-revalidate'
            : 'public, max-age=60, stale-while-revalidate=30'
    );
    res.setHeader('Vary', 'Authorization');

    const eTag = generateETag(result);

    // Check If-None-Match header (sent by client if cached)
    if (req.headers['if-none-match'] === eTag) {
        return res.status(304).end(); // No change
    }

    // Set ETag header in the response
    res.setHeader('ETag', eTag);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Podcast retrieved successfully',
        data: result,
    });
});

const deletePodcast = catchAsync(async (req, res) => {
    const result = await podcastService.deletePodcastFromDB(
        req.user,

        req.params.id
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Podcast deleted successfully',
        data: result,
    });
});
const viewPodcast = catchAsync(async (req, res) => {
    const result = await podcastService.countPodcastView(
        req.user.profileId,
        req.params.id
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Podcast viewed successfully',
        data: result,
    });
});
const getHomeData = catchAsync(async (req, res) => {
    const result = await podcastService.getHomeData();
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Podcast home data retrieved successfully',
        data: result,
    });
});
const getPodcastForSubcategories = catchAsync(async (req, res) => {
    const result = await podcastService.getPodcastForSubcategories(
        req.params.id
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Subcategory with podcasts successfully',
        data: result,
    });
});
const toggleLikePodcast = catchAsync(async (req, res) => {
    const result = await podcastService.toggleLikePodcast(
        req.params.id,
        req.user
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: result.isLike ? 'Liked successfully' : 'Unliked successfully',
        data: result,
    });
});
const globalSearch = catchAsync(async (req, res) => {
    const result = await podcastService.globalSearch(req.query);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Global search results retrieved successfully',
        data: result,
    });
});

const setPodcastStatus = catchAsync(async (req, res) => {
    const result = await podcastService.setPodcastStatus(
        req.params.id,
        req.body.status
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message:
            result.status === 'hidden'
                ? 'Podcast hidden from the app'
                : 'Podcast published',
        data: result,
    });
});

const podcastController = {
    setPodcastStatus,
    createPodcast,
    updatePodcast,
    getAllPodcasts,
    getSinglePodcast,
    deletePodcast,
    getHomeData,
    viewPodcast,
    getPodcastFeedForUser,
    getPodcastForSubcategories,
    getMyPodcasts,
    toggleLikePodcast,
    globalSearch,
};

export default podcastController;
