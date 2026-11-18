import { model, Schema } from 'mongoose';
import { IBookmark } from './bookmark.interface';

const bookmarkSchema = new Schema<IBookmark>(
    {
        podcast: {
            type: Schema.Types.ObjectId,
            default: null,
            ref: 'Podcast',
        },
        user: {
            type: String,
            required: true,
        },
    },
    {
        timestamps: true,
    }
);

// "Has this user bookmarked X" / "this user's bookmarks" were unindexed collection scans.
bookmarkSchema.index({ user: 1, podcast: 1 });
bookmarkSchema.index({ podcast: 1 });

const Bookmark = model('Bookmark', bookmarkSchema);

export default Bookmark;
