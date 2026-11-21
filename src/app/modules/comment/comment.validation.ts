import { z } from 'zod';
import { Types } from 'mongoose';

const ObjectIdSchema = (fieldName: string) =>
    z
        .string({ required_error: `${fieldName} is required` })
        .min(1, `${fieldName} cannot be empty`)
        .refine((val) => Types.ObjectId.isValid(val), {
            message: `${fieldName} must be a valid ObjectId`,
        });

const TextSchema = z
    .string({ required_error: 'Text is required' })
    .trim()
    .min(1, { message: 'Text is required' })
    .max(500, { message: 'Text cannot exceed 500 characters' });

const idParams = z.object({ id: ObjectIdSchema('Id') });

const createCommentSchema = z.object({
    body: z.object({
        podcast: ObjectIdSchema('Podcast id'),
        text: TextSchema,
    }),
});

const updateCommentValidationSchema = z.object({
    params: idParams,
    body: z.object({ text: TextSchema }),
});

const createReplySchema = z.object({
    body: z.object({
        parent: ObjectIdSchema('Parent comment id'),
        text: TextSchema,
    }),
});

/** For routes that only take an `:id` (delete, like, list). */
const idParamSchema = z.object({ params: idParams });

const CommentValidations = {
    createCommentSchema,
    createReplySchema,
    updateCommentValidationSchema,
    idParamSchema,
};

export default CommentValidations;
