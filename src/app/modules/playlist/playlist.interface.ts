import { Types } from 'mongoose';

export interface IPodcastPlaylist {
    user: Types.ObjectId;
    userType: 'NormalUser' | 'Creator';
    name: string;
    description?: string;
    tags: string[];
    cover_image?: string | null;
    /** false → only the owner and admins can open it. */
    isPublic: boolean;
    podcasts: Types.ObjectId[];
}
