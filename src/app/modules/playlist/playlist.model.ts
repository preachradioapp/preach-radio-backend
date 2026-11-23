import { Schema, model, Types } from 'mongoose';
import { IPodcastPlaylist } from './playlist.interface';

/** Max podcasts in one playlist (keeps the document small; ~6 KB of ids). */
export const PLAYLIST_MAX_PODCASTS = 500;

const podcastPlaylistSchema = new Schema<IPodcastPlaylist>(
    {
        user: {
            type: Schema.Types.ObjectId,
            required: true,
            refPath: 'userType',
        },
        userType: {
            type: String,
            required: true,
            enum: ['NormalUser', 'Creator'],
        },
        name: { type: String, required: true, trim: true },
        description: { type: String, trim: true, default: '' },
        tags: { type: [String], default: [] },
        // Optional: the app falls back to the podcasts' covers.
        cover_image: { type: String, default: null },
        // Private by default: only the owner (and admins) can open it.
        isPublic: { type: Boolean, default: false },
        // Ordered. Kept unique by the service ($addToSet / de-dup); deleted podcasts are $pull-ed.
        podcasts: {
            type: [{ type: Types.ObjectId, ref: 'Podcast' }],
            default: [],
            validate: {
                validator: (v: unknown[]) => v.length <= PLAYLIST_MAX_PODCASTS,
                message: `A playlist can hold at most ${PLAYLIST_MAX_PODCASTS} podcasts`,
            },
        },
    },
    { timestamps: true }
);

// "My playlists" (newest first) — was a full collection scan.
podcastPlaylistSchema.index({ user: 1, updatedAt: -1 });
// Removing a deleted podcast from every playlist that has it.
podcastPlaylistSchema.index({ podcasts: 1 });
// Public playlists (listing for other users).
podcastPlaylistSchema.index({ isPublic: 1, updatedAt: -1 });

const PodcastPlaylist = model<IPodcastPlaylist>(
    'PodcastPlaylist',
    podcastPlaylistSchema
);
export default PodcastPlaylist;
