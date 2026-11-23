import { z } from 'zod';

export const createPodcastPlaylistValidationSchema = z.object({
    body: z.object({
        name: z.string({ required_error: 'Name is required' }).trim().min(1, 'Name is required'),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        isPublic: z.boolean().optional(),
        // May be empty: "New playlist", then add podcasts one by one.
        podcasts: z
            .array(z.string().length(24, 'Invalid podcast ID'))
            .max(500, 'A playlist can hold at most 500 podcasts')
            .optional(),
    }),
});

export const updatePodcastPlaylistValidationSchema = z.object({
    body: z
        .object({
            name: z.string().optional(),
            description: z.string().optional(),
            tags: z.array(z.string()).optional(),
            cover_image: z.string().optional(),
            isPublic: z.boolean().optional(),
            podcasts: z
                .array(z.string().length(24))
                .max(500, 'A playlist can hold at most 500 podcasts')
                .optional(),
        })
        .refine((data) => Object.keys(data).length > 0, {
            message: 'At least one field must be provided for update',
        }),
});

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const addPodcastValidationSchema = z.object({
    params: z.object({ playlistId: objectId }),
    body: z.object({ podcastId: objectId }),
});

export const removePodcastValidationSchema = z.object({
    params: z.object({ playlistId: objectId, podcastId: objectId }),
});

const PodcastPlaylistValidations = {
    addPodcastValidationSchema,
    removePodcastValidationSchema,
    createPodcastPlaylistValidationSchema,
    updatePodcastPlaylistValidationSchema,
};

export default PodcastPlaylistValidations;
