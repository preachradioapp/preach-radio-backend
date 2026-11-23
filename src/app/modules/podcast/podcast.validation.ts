import { z } from 'zod';
import { CLIP_MAX_SECONDS } from './podcast.constant';
import {
    PODCAST_MEDIA_TYPES,
    PODCAST_STATUS,
    PODCAST_TYPES,
} from './podcast.interface';

const objectId = (label: string) =>
    z
        .string({ required_error: `${label} is required` })
        .regex(/^[a-f\d]{24}$/i, `${label} must be a valid id`);

const locationSchema = z.object({
    type: z.literal('Point'),
    coordinates: z
        .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
        .describe('[longitude, latitude]'),
});

// Limits are deliberately generous so existing mobile clients are not rejected.
const podcastBody = z.object({
    type: z.enum(PODCAST_TYPES).optional(), // defaults to 'episode'
    sourcePodcast: objectId('Source podcast').nullable().optional(),
    category: objectId('Category'),
    subCategory: objectId('Sub category'),
    station: objectId('Station').optional(), // ignored: ownership is server-set
    coverImage: z.string().url('Cover image must be a URL').optional(),
    podcast_url: z.string().url('Podcast URL must be a URL').optional(),
    mediaType: z.enum(PODCAST_MEDIA_TYPES).optional(),
    title: z.string().trim().min(1, 'Title is required').max(300),
    description: z.string().trim().min(1, 'Description is required').max(10000),
    // Required for episodes, optional for clips (checked below).
    location: locationSchema.optional(),
    address: z
        .string()
        .trim()
        .min(1, 'Address is required')
        .max(500)
        .optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    // Legacy field, format unchanged. `coerce` accepts numeric strings, which
    // Mongoose also accepts.
    duration: z.coerce
        .number({ invalid_type_error: 'Duration must be a number' })
        .nonnegative('Duration cannot be negative'),
    // Unambiguous length in seconds. Required for clips (2-minute rule).
    durationSeconds: z.coerce
        .number({ invalid_type_error: 'durationSeconds must be a number' })
        .int('durationSeconds must be whole seconds')
        .nonnegative('durationSeconds cannot be negative')
        .optional(),
    // Optional video size as displayed (rotation applied). Lets the server pick the
    // HLS ladder's orientation; without it clips are assumed vertical.
    videoWidth: z.coerce
        .number({ invalid_type_error: 'videoWidth must be a number' })
        .int('videoWidth must be whole pixels')
        .positive('videoWidth must be positive')
        .max(16384, 'videoWidth is too large')
        .optional(),
    videoHeight: z.coerce
        .number({ invalid_type_error: 'videoHeight must be a number' })
        .int('videoHeight must be whole pixels')
        .positive('videoHeight must be positive')
        .max(16384, 'videoHeight is too large')
        .optional(),
});

type TPodcastBody = Partial<z.infer<typeof podcastBody>>;

/** Rules that depend on the podcast type. Also used by the service for updates. */
export const typeRuleViolations = (body: TPodcastBody): string[] => {
    const errors: string[] = [];
    if (body.type === 'clip') {
        if (body.durationSeconds === undefined) {
            errors.push('Clips need their length in seconds (durationSeconds)');
        } else if (body.durationSeconds > CLIP_MAX_SECONDS) {
            errors.push(
                `Clips can be at most ${CLIP_MAX_SECONDS / 60} minutes long`
            );
        }
    } else {
        if (!body.location) errors.push('Location is required');
        if (!body.address) errors.push('Address is required');
        if (body.sourcePodcast) {
            errors.push('Only clips can link to a source podcast');
        }
    }
    return errors;
};

const createPodcastValidationSchema = z.object({
    body: podcastBody.superRefine((body, ctx) => {
        typeRuleViolations(body).forEach((message) =>
            ctx.addIssue({ code: z.ZodIssueCode.custom, message })
        );
    }),
});

// Type rules for updates are checked in the service against the merged record.
const updatePodcastValidationSchema = z.object({
    body: podcastBody.partial(),
});

const updatePodcastStatusValidationSchema = z.object({
    body: z.object({ status: z.enum(PODCAST_STATUS) }),
});

const podcastValidation = {
    createPodcastValidationSchema,
    updatePodcastValidationSchema,
    updatePodcastStatusValidationSchema,
};

export default podcastValidation;
