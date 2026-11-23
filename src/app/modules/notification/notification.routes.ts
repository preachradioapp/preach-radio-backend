import express from 'express';
import auth from '../../middlewares/auth';
import validateRequest from '../../middlewares/validateRequest';
import { USER_ROLE } from '../user/user.constant';
import notificationController from './notification.controller';
import { broadcastValidationSchema } from './notification.validation';

const router = express.Router();
const inbox = auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user, USER_ROLE.creator);

router.get('/get-notifications', inbox, notificationController.getAllNotification);
router.get('/unseen-count', inbox, notificationController.getUnseenCount);
router.patch('/see-notifications', inbox, notificationController.seeNotification);
router.patch('/see-notification/:id', inbox, notificationController.seeSingleNotification);
router.delete('/delete-notification/:id', inbox, notificationController.deleteNoficiation);

// Dashboard: announcements to all users / listeners / creators (inbox + push, delivered in the background).
router.post('/broadcast', auth(USER_ROLE.superAdmin), validateRequest(broadcastValidationSchema), notificationController.createBroadcast);
router.get('/broadcasts', auth(USER_ROLE.superAdmin), notificationController.getBroadcasts);

export const notificationRoutes = router;
