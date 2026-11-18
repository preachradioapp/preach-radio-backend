import express, { NextFunction, Request, Response } from 'express';
import { uploadFile } from '../../helper/mutler-s3-uploader';
import auth from '../../middlewares/auth';
import simpleAuth from '../../middlewares/simpleAuth';
import validateRequest from '../../middlewares/validateRequest';
import { USER_ROLE } from '../user/user.constant';
import podcastController from './podcast.controller';
import podcastValidation from './podcast.validation';

const router = express.Router();
//
router.post(
    '/create',
    auth(USER_ROLE.creator, USER_ROLE.superAdmin),
    validateRequest(podcastValidation.createPodcastValidationSchema),
    podcastController.createPodcast
);
////
router.patch(
    '/update/:id',
    auth(USER_ROLE.creator, USER_ROLE.superAdmin),
    uploadFile(),
    (req: Request, res: Response, next: NextFunction) => {
        if (req.body.data) {
            req.body = JSON.parse(req.body.data);
        }
        next();
    },
    validateRequest(podcastValidation.updatePodcastValidationSchema),
    podcastController.updatePodcast
);

// Optional auth: lets admins request hidden podcasts (`includeHidden=true`).
router.get('/all', simpleAuth, podcastController.getAllPodcasts);

// Admin moderation: hide / publish a podcast without deleting it.
// Admin: (re)convert a podcast's media to HLS — retry after a failure, or re-run.
router.post(
    '/reprocess/:id',
    auth(USER_ROLE.superAdmin),
    podcastController.reprocessPodcast
);
router.patch(
    '/status/:id',
    auth(USER_ROLE.superAdmin),
    validateRequest(podcastValidation.updatePodcastStatusValidationSchema),
    podcastController.setPodcastStatus
);
router.get(
    '/my-podcasts',
    auth(USER_ROLE.creator, USER_ROLE.superAdmin),
    podcastController.getMyPodcasts
);
// get podcast feed for user
router.get(
    '/get-podcast-feed',
    auth(USER_ROLE.user, USER_ROLE.creator, USER_ROLE.superAdmin),
    podcastController.getPodcastFeedForUser
);
router.get(
    '/get-single/:id',
    // Optional auth: adds isLike/isBookmark for signed-in users. Cache headers
    // are set in the controller (public when anonymous, private when signed in).
    simpleAuth,
    podcastController.getSinglePodcast
);
router.delete(
    '/delete-podcast/:id',
    auth(USER_ROLE.creator, USER_ROLE.superAdmin),
    podcastController.deletePodcast
);
router.post(
    '/view/:id',
    auth(USER_ROLE.user, USER_ROLE.creator),
    podcastController.viewPodcast
);
router.get(
    '/subcategory-with-podcasts/:id',
    podcastController.getPodcastForSubcategories
);
router.post(
    '/like-unlike/:id',
    auth(USER_ROLE.user, USER_ROLE.creator),
    podcastController.toggleLikePodcast
);

router.get('/get-home-data', podcastController.getHomeData);
router.get('/global-search', podcastController.globalSearch);
export const podcastRoutes = router;
