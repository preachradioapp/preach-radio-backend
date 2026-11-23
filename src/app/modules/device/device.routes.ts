import express from 'express';
import auth from '../../middlewares/auth';
import validateRequest from '../../middlewares/validateRequest';
import { USER_ROLE } from '../user/user.constant';
import deviceController from './device.controller';
import {
    registerDeviceValidationSchema,
    unregisterDeviceValidationSchema,
} from './device.validation';

const router = express.Router();

// The app calls this after login and on every launch (idempotent).
router.post(
    '/register',
    auth(USER_ROLE.user, USER_ROLE.creator),
    validateRequest(registerDeviceValidationSchema),
    deviceController.registerDevice
);

// Before logout, so this install stops getting the user's pushes.
router.post(
    '/unregister',
    auth(USER_ROLE.user, USER_ROLE.creator),
    validateRequest(unregisterDeviceValidationSchema),
    deviceController.unregisterDevice
);

export const deviceRoutes = router;
