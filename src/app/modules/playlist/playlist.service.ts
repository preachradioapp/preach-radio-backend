/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../error/appError';

import { deleteFileFromS3 } from '../../helper/deleteFromS3';
import { IPodcastPlaylist } from './playlist.interface';
import PodcastPlaylist, { PLAYLIST_MAX_PODCASTS } from './playlist.model';
import Podcast from '../podcast/podcast.model';
import { USER_ROLE } from '../user/user.constant';

/** Fields a client may set. Ownership (`user`, `userType`) is always the server's. */
const EDITABLE_FIELDS = [
    'name',
    'description',
    'tags',
    'cover_image',
    'isPublic',
    'podcasts',
] as const;
type EditablePlaylist = Pick<IPodcastPlaylist, (typeof EDITABLE_FIELDS)[number]>;

/**
 * Copy only editable fields (`validateRequest` validates but does not strip
 * `req.body`, so `user` / `userType` / `_id` could otherwise be overwritten).
 * Podcast ids are de-duplicated, keeping the first occurrence's position.
 */
const pickEditable = (payload: Record<string, unknown>) => {
    const out: Partial<EditablePlaylist> = {};
    for (const key of EDITABLE_FIELDS) {
        if (payload[key] !== undefined) (out as any)[key] = payload[key];
    }
    if (Array.isArray(out.podcasts)) {
        out.podcasts = [
            ...new Set(out.podcasts.map((id) => String(id))),
        ] as any;
    }
    return out;
};

/** `refPath` model for the owner, from the signed-in role. */
const userTypeForRole = (role: string): IPodcastPlaylist['userType'] => {
    if (role === USER_ROLE.creator) return 'Creator';
    if (role === USER_ROLE.user) return 'NormalUser';
    throw new AppError(
        httpStatus.FORBIDDEN,
        'Only listeners and creators can own playlists'
    );
};

// Create Playlist
const createPlaylist = async (
    userId: string,
    role: string,
    payload: Record<string, unknown>
) => {
    return await PodcastPlaylist.create({
        ...pickEditable(payload),
        user: userId,
        userType: userTypeForRole(role),
    });
};

/** Who is asking: admins see every playlist; everyone else sees their own and public ones. */
export type PlaylistViewer = { profileId: string; role: string };
const isAdmin = (viewer: PlaylistViewer) =>
    viewer.role === USER_ROLE.superAdmin || viewer.role === USER_ROLE.admin;

// Get All Playlists — admins: all; other users: public playlists only.
const getAllPlaylists = async (
    query: Record<string, unknown>,
    viewer: PlaylistViewer
) => {
    // Never let a query param widen what a non-admin may see.
    const rest = { ...query };
    delete rest.isPublic;
    const filter = isAdmin(viewer) ? {} : { isPublic: true };
    const playlistQuery = new QueryBuilder(
        PodcastPlaylist.find(filter).populate({
            path: 'user',
            select: 'name profile_image',
        }),
        isAdmin(viewer) ? query : rest
    )
        .search(['name', 'description'])
        .filter()
        .sort()
        .paginate()
        .fields();

    const result = await playlistQuery.modelQuery;
    const meta = await playlistQuery.countTotal();

    return { meta, result };
};

const getMyPlaylists = async (
    userId: string,
    query: Record<string, unknown>
) => {
    const playlistQuery = new QueryBuilder(
        PodcastPlaylist.find({ user: userId }),
        query
    )
        .search(['name', 'description'])
        .filter()
        .sort()
        .paginate()
        .fields();

    const result = await playlistQuery.modelQuery;
    const meta = await playlistQuery.countTotal();

    return { meta, result };
};



/**
 * A private playlist opens only for its owner and admins. Others get 404 (not 403),
 * so the id doesn't reveal that a private playlist exists.
 */
const getPlaylistById = async (playlistId: string, viewer: PlaylistViewer) => {
    // Access is part of the query (not checked after populate, where a missing owner doc becomes null).
    const access = isAdmin(viewer)
        ? {}
        : { $or: [{ isPublic: true }, { user: viewer.profileId }] };
    const playlist = await PodcastPlaylist.findOne({ _id: playlistId, ...access })
        .populate('user', 'name profile_image')
        .populate({
            path: 'podcasts',
            populate: [
                {
                    path: 'creator',
                    select: 'name profile_image',
                },
                {
                    path: 'category',
                    select: 'name',
                },
                {
                    path: 'subCategory',
                    select: 'name',
                },
                {
                    path: 'station',
                    select: 'name profile_image',
                },
            ],
        });

    if (!playlist) {
        throw new AppError(httpStatus.NOT_FOUND, 'Podcast playlist not found');
    }

    return playlist;
};

const updatePlaylist = async (
    userId: string,
    playlistId: string,
    body: Record<string, unknown>
) => {
    const payload = pickEditable(body);
    const playlist = await PodcastPlaylist.findOne({
        user: userId,
        _id: playlistId,
    });
    if (!playlist) {
        throw new AppError(httpStatus.NOT_FOUND, 'Podcast playlist not found');
    }

    const updated = await PodcastPlaylist.findOneAndUpdate(
        { _id: playlistId, user: userId },
        { $set: payload },
        {
            new: true,
            runValidators: true,
        }
    );

    if (
        payload.cover_image &&
        playlist.cover_image &&
        payload.cover_image !== playlist.cover_image
    ) {
        deleteFileFromS3(playlist.cover_image);
    }

    return updated;
};

const deletePlaylist = async (userId: string, playlistId: string) => {
    const playlist = await PodcastPlaylist.findOne({
        user: userId,
        _id: playlistId,
    });
    if (!playlist) {
        throw new AppError(httpStatus.NOT_FOUND, 'Podcast playlist not found');
    }

    const result = await PodcastPlaylist.findByIdAndDelete(playlistId);
    if (playlist.cover_image) {
        deleteFileFromS3(playlist.cover_image);
    }

    return result;
};

export { PLAYLIST_MAX_PODCASTS };

/**
 * Add one podcast, atomically. `$addToSet` never duplicates, and two devices
 * adding at the same time can't overwrite each other (unlike sending the whole array).
 */
const addPodcastToPlaylist = async (
    userId: string,
    playlistId: string,
    podcastId: string
) => {
    if (!(await Podcast.exists({ _id: podcastId }))) {
        throw new AppError(httpStatus.NOT_FOUND, 'Podcast not found');
    }
    const updated = await PodcastPlaylist.findOneAndUpdate(
        {
            _id: playlistId,
            user: userId,
            // Size cap, checked in the same atomic step.
            [`podcasts.${PLAYLIST_MAX_PODCASTS - 1}`]: { $exists: false },
        },
        { $addToSet: { podcasts: podcastId } },
        { new: true }
    );
    if (updated) return updated;

    // Tell "not yours / missing" apart from "full".
    const exists = await PodcastPlaylist.exists({
        _id: playlistId,
        user: userId,
    });
    if (!exists) {
        throw new AppError(httpStatus.NOT_FOUND, 'Podcast playlist not found');
    }
    throw new AppError(
        httpStatus.BAD_REQUEST,
        `A playlist can hold at most ${PLAYLIST_MAX_PODCASTS} podcasts`
    );
};

/** Remove one podcast, atomically. Removing one that isn't there is a no-op. */
const removePodcastFromPlaylist = async (
    userId: string,
    playlistId: string,
    podcastId: string
) => {
    const updated = await PodcastPlaylist.findOneAndUpdate(
        { _id: playlistId, user: userId },
        { $pull: { podcasts: podcastId } },
        { new: true }
    );
    if (!updated) {
        throw new AppError(httpStatus.NOT_FOUND, 'Podcast playlist not found');
    }
    return updated;
};

/** Called when podcasts are deleted: take them out of every playlist (uses the `podcasts` index). */
const pullPodcastsFromPlaylists = (podcastIds: unknown[]) =>
    PodcastPlaylist.updateMany(
        { podcasts: { $in: podcastIds } },
        { $pull: { podcasts: { $in: podcastIds } } },
        { timestamps: false } // not an edit by the owner: keep their "updated" order
    );

/** Called when an account is deleted: its playlists (and their cover files) go too. */
const deletePlaylistsOfUser = async (profileId: string) => {
    const own = await PodcastPlaylist.find({ user: profileId })
        .select('cover_image')
        .lean();
    if (!own.length) return 0;
    await PodcastPlaylist.deleteMany({ user: profileId });
    own.forEach((p) => p.cover_image && deleteFileFromS3(p.cover_image));
    return own.length;
};

const PodcastPlaylistService = {
    pullPodcastsFromPlaylists,
    deletePlaylistsOfUser,
    addPodcastToPlaylist,
    removePodcastFromPlaylist,
    createPlaylist,
    getAllPlaylists,
    getPlaylistById,
    getMyPlaylists,
    updatePlaylist,
    deletePlaylist,
};

export default PodcastPlaylistService;
