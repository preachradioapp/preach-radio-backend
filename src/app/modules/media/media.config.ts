/**
 * Media conversion settings, read from the environment on every call so that a
 * changed `.env` (and the tests) take effect without code changes.
 *
 * Required in production (see docs/AWS_MEDIA_SETUP — "Step 10"):
 *   TRANSCODE_ENABLED=true
 *   MEDIACONVERT_ROLE_ARN=arn:aws:iam::<account>:role/PreachRadioMediaConvertRole
 *   MEDIA_WEBHOOK_SECRET=<64 hex chars, same value as the EventBridge connection>
 * Optional:
 *   MEDIACONVERT_REGION (default AWS_REGION, then us-east-1)
 *   MEDIACONVERT_ENDPOINT, MEDIACONVERT_QUEUE_ARN
 *   AWS_S3_BUCKET_NAME (default preach-radio), CLOUDFRONT_URL
 */
export const mediaConfig = () => ({
    enabled: process.env.TRANSCODE_ENABLED === 'true',
    region:
        process.env.MEDIACONVERT_REGION || process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.MEDIACONVERT_ENDPOINT || undefined,
    queueArn: process.env.MEDIACONVERT_QUEUE_ARN || undefined,
    roleArn: process.env.MEDIACONVERT_ROLE_ARN || '',
    bucket: process.env.AWS_S3_BUCKET_NAME || 'preach-radio',
    cdnBase: (
        process.env.CLOUDFRONT_URL || 'https://d2263773avtgf9.cloudfront.net'
    ).replace(/\/+$/, ''),
    webhookSecret: process.env.MEDIA_WEBHOOK_SECRET || '',
});

/** Every job carries `userMetadata.app = JOB_APP_TAG`; the EventBridge rule matches on it. */
export const JOB_APP_TAG = 'preach-radio';

/** Start attempts before a podcast is marked `failed` (it stays playable from podcast_url). */
export const MAX_START_ATTEMPTS = 3;

/** Converted files live under media/<podcastId>/<runId>/ in the bucket. */
export const MEDIA_ROOT = 'media';
