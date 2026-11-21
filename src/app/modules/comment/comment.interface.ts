import { Types } from 'mongoose';

export type TCommentorType = 'NormalUser' | 'Creator';

export interface ICommentLiker {
    likerId: Types.ObjectId;
    likerType: TCommentorType;
}

/**
 * A comment on a podcast. Replies live in the same collection: `parent` is null
 * for a top-level comment and points at the comment being answered otherwise,
 * so threads can nest (reply → reply → …).
 */
export interface IComment {
    _id?: Types.ObjectId;
    podcast: Types.ObjectId;
    text: string;
    likers: ICommentLiker[];
    parent: Types.ObjectId | null;
    commentor: Types.ObjectId;
    commentorType: TCommentorType;
    /** Set when the author edits the text (likes don't count as edits). */
    editedAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
}
