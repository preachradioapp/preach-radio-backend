import { Buffer } from 'buffer';
import { timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import { mediaConfig } from './media.config';
import mediaService from './media.service';

/** Constant-time comparison so the secret can't be guessed byte by byte. */
export const secretMatches = (given: unknown, expected: string) => {
    if (typeof given !== 'string' || !expected) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * POST /webhooks/mediaconvert — called by the EventBridge API destination when a
 * job completes or fails. The EventBridge connection adds `x-webhook-secret`.
 * Answers 2xx for anything it understood (even ignored events) so EventBridge
 * doesn't retry them; 401/503 for auth or configuration problems.
 */
const mediaConvertWebhook = catchAsync(async (req: Request, res: Response) => {
    const { webhookSecret } = mediaConfig();
    if (!webhookSecret) {
        res.status(httpStatus.SERVICE_UNAVAILABLE).json({
            success: false,
            message: 'The media webhook is not configured',
        });
        return;
    }
    if (!secretMatches(req.header('x-webhook-secret'), webhookSecret)) {
        res.status(httpStatus.UNAUTHORIZED).json({
            success: false,
            message: 'Invalid webhook secret',
        });
        return;
    }
    const data = await mediaService.handleJobStateEvent(req.body);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: `Event ${data.outcome}`,
        data,
    });
});

const mediaController = { mediaConvertWebhook };
export default mediaController;
