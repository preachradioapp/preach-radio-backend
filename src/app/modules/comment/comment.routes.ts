import express from 'express';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import validateRequest from '../../middlewares/validateRequest';
import commentValidations from './comment.validation';
import commentController from './comment.controller';

const router = express.Router();

const members = [USER_ROLE.user, USER_ROLE.creator] as const;
// Admins can read and moderate (delete) comments, but not write them.
const membersAndAdmins = [...members, USER_ROLE.admin, USER_ROLE.superAdmin] as const;

router.post(
    '/create',
    auth(...members),
    validateRequest(commentValidations.createCommentSchema),
    commentController.createComment
);
router.post(
    '/create-reply',
    auth(...members),
    validateRequest(commentValidations.createReplySchema),
    commentController.createReply
);
router.patch(
    '/update-comment/:id',
    auth(...members),
    validateRequest(commentValidations.updateCommentValidationSchema),
    commentController.updateComment
);
router.delete(
    '/delete-comment/:id',
    auth(...membersAndAdmins),
    validateRequest(commentValidations.idParamSchema),
    commentController.deleteComment
);

router.post(
    '/like-unlike-comment/:id',
    auth(...members),
    validateRequest(commentValidations.idParamSchema),
    commentController.likeUnlikeComment
);

router.get(
    '/get-podcast-comments/:id',
    auth(...membersAndAdmins),
    validateRequest(commentValidations.idParamSchema),
    commentController.getPodcastComments
);

router.get(
    '/get-replies/:id',
    auth(...membersAndAdmins),
    validateRequest(commentValidations.idParamSchema),
    commentController.getReplies
);

export const commentRoutes = router;
