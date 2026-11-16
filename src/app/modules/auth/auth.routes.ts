import { Router } from 'express';
import validateRequest from '../../middlewares/validateRequest';
import auth from '../../middlewares/auth';
import { authRateLimiter } from '../../middlewares/rateLimiter';
import authControllers from './auth.controller';
import { USER_ROLE } from '../user/user.constant';
import authValidations from './auth.validation';

const router = Router();

router.post(
    '/login',
    authRateLimiter,
    validateRequest(authValidations.loginValidationSchema),
    authControllers.loginUser
);

router.post(
    '/change-password',
    auth(
        USER_ROLE.user,
        USER_ROLE.admin,
        USER_ROLE.superAdmin,
        USER_ROLE.creator
    ),
    validateRequest(authValidations.changePasswordValidationSchema),
    authControllers.changePassword
);
router.post(
    '/refresh-token',
    // No access-token auth here on purpose: this endpoint's entire job is to
    // issue a new access token once the old one has expired, using the
    // refresh token cookie (checked by validateRequest below) instead.
    validateRequest(authValidations.refreshTokenValidationSchema),
    authControllers.refreshToken
);

router.post(
    '/forget-password',
    authRateLimiter,
    validateRequest(authValidations.forgetPasswordValidationSchema),
    authControllers.forgetPassword
);
router.post(
    '/reset-password',
    authRateLimiter,
    validateRequest(authValidations.resetPasswordValidationSchema),
    authControllers.resetPassword
);
router.post(
    '/verify-reset-otp',
    authRateLimiter,
    validateRequest(authValidations.verifyResetOtpValidationSchema),
    authControllers.verifyResetOtp
);

router.post(
    '/resend-reset-code',
    authRateLimiter,
    validateRequest(authValidations.resendResetCodeValidationSchema),
    authControllers.resendResetCode
);

router.post(
    '/resend-verify-code',
    authRateLimiter,
    validateRequest(authValidations.resendResetCodeValidationSchema),
    authControllers.resendResetCode
);

router.post('/oauth-login', authRateLimiter, authControllers.oAuthLogin);

export const authRoutes = router;
