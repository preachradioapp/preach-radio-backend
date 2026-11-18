import { model, Schema, Types } from 'mongoose';

export const LIKER_TYPES = ['NormalUser', 'Creator'] as const;
export type TLikerType = (typeof LIKER_TYPES)[number];

export interface ILike {
    podcast: Types.ObjectId;
    user: Types.ObjectId; // profile id (NormalUser or Creator)
    userType: TLikerType;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * One document per (podcast, user) like.
 * Replaces the unbounded `likers` array that used to be embedded in Podcast:
 * - the unique index makes like/unlike race-free (no double likes)
 * - "what has this user liked" is an indexed query instead of a collection scan
 * - podcast documents no longer grow with every like
 */
const likeSchema = new Schema<ILike>(
    {
        podcast: {
            type: Schema.Types.ObjectId,
            ref: 'Podcast',
            required: true,
        },
        user: {
            type: Schema.Types.ObjectId,
            refPath: 'userType',
            required: true,
        },
        userType: {
            type: String,
            enum: LIKER_TYPES,
            required: true,
        },
    },
    { timestamps: true }
);

// Profile ids are globally unique ObjectIds, so (podcast, user) identifies a like.
likeSchema.index({ podcast: 1, user: 1 }, { unique: true });
// Feed: "which podcasts has this user liked", newest first.
likeSchema.index({ user: 1, createdAt: -1 });

const Like = model<ILike>('Like', likeSchema);
export default Like;
