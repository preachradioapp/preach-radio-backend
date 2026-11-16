import rateLimit from 'express-rate-limit';
import httpStatus from 'http-status';

// Throttles brute-forceable auth endpoints (login, OTP, password reset).
// Keyed by IP by default; returns a plain 429 instead of leaking details.
export const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        statusCode: httpStatus.TOO_MANY_REQUESTS,
        message: 'Too many attempts. Please try again later.',
    },
});
