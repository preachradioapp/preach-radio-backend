import { model, Schema } from 'mongoose';
import { IComment } from './comment.interface';

const COMMENTOR_TYPES = ['NormalUser', 'Creator'];

const commentSchema = new Schema<IComment>(
    {
        podcast: {
            type: Schema.Types.ObjectId,
            ref: 'Podcast',
            required: true,
        },
        commentor: {
            type: Schema.Types.ObjectId,
            refPath: 'commentorType',
            required: true,
        },
        commentorType: {
            type: String,
            enum: COMMENTOR_TYPES,
            required: true,
        },
        text: {
            type: String,
            required: true,
            trim: true,
            maxlength: 500,
        },
        likers: [
            {
                _id: false,
                likerId: { type: Schema.Types.ObjectId, required: true },
                likerType: {
                    type: String,
                    enum: COMMENTOR_TYPES,
                    required: true,
                },
            },
        ],
        parent: {
            type: Schema.Types.ObjectId,
            ref: 'Comment',
            default: null,
        },
        editedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

// Top-level comments of a podcast, newest first (also serves per-podcast counts).
commentSchema.index({ podcast: 1, parent: 1, createdAt: -1 });
// Replies of a comment, in conversation order; also used to count replies.
commentSchema.index({ parent: 1, createdAt: 1 });
// Account deletion removes a user's comments.
commentSchema.index({ commentor: 1 });

const Comment = model<IComment>('Comment', commentSchema);
export default Comment;
