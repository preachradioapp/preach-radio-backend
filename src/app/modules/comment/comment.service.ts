/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import { JwtPayload } from 'jsonwebtoken';
import { PipelineStage, Types } from 'mongoose';
import AppError from '../../error/appError';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import Notification from '../notification/notification.model';
import Podcast from '../podcast/podcast.model';
import { USER_ROLE } from '../user/user.constant';
import { IComment, TCommentorType } from './comment.interface';
import Comment from './comment.model';

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 10;
/** Safety net for walking a reply thread when deleting it. */
const MAX_THREAD_DEPTH = 100;

const toObjectId = (id: string | Types.ObjectId) =>
    typeof id === 'string' ? new Types.ObjectId(id) : id;

const commentorTypeOf = (user: JwtPayload): TCommentorType =>
    user.role === USER_ROLE.creator ? 'Creator' : 'NormalUser';

const isAdmin = (user: JwtPayload) =>
    user.role === USER_ROLE.admin || user.role === USER_ROLE.superAdmin;

const pagination = (query: Record<string, any>) => {
    const page = Math.max(parseInt(query.page as string) || 1, 1);
    const limit = Math.min(
        Math.max(parseInt(query.limit as string) || DEFAULT_PAGE_SIZE, 1),
        MAX_PAGE_SIZE
    );
    return { page, limit, skip: (page - 1) * limit };
};

/** The podcast a comment belongs to (hidden podcasts count as gone for the app). */
const findPodcastOwner = async (podcastId: Types.ObjectId | string) => {
    const podcast = await Podcast.findById(podcastId)
        .select('creator title')
        .lean<{ _id: Types.ObjectId; creator?: Types.ObjectId | null; title?: string }>();
    if (!podcast) throw new AppError(httpStatus.NOT_FOUND, 'Podcast not found');
    return podcast;
};

interface ViewContext {
    viewer: JwtPayload;
    /** The podcast's creator profile: shown as "Author" and allowed to moderate. */
    ownerId?: Types.ObjectId | null;
}

/**
 * Lookups that turn raw comment documents into what the app renders: the author's
 * name/avatar (NormalUser or Creator) and the number of direct replies.
 * Runs only on the page being returned.
 */
const decorateStages = (): PipelineStage[] => [
    {
        $lookup: {
            from: 'normalusers',
            localField: 'commentor',
            foreignField: '_id',
            pipeline: [{ $project: { name: 1, profile_image: 1 } }],
            as: 'normalProfile',
        },
    },
    {
        $lookup: {
            from: 'creators',
            localField: 'commentor',
            foreignField: '_id',
            pipeline: [{ $project: { name: 1, profile_image: 1 } }],
            as: 'creatorProfile',
        },
    },
    {
        // Uses the { parent, createdAt } index; never loads the replies themselves.
        $lookup: {
            from: 'comments',
            localField: '_id',
            foreignField: 'parent',
            pipeline: [{ $count: 'n' }],
            as: 'replyCount',
        },
    },
];

/** Final, stable response shape (keeps the fields the Flutter app already reads). */
const toView = (doc: any, { viewer, ownerId }: ViewContext) => {
    const profile =
        doc.commentorType === 'Creator'
            ? doc.creatorProfile?.[0]
            : doc.normalProfile?.[0];
    const viewerId = String(viewer.profileId);
    const likers: { likerId: Types.ObjectId }[] = doc.likers ?? [];
    const isMyComment = String(doc.commentor) === viewerId;
    const isOwner = Boolean(ownerId) && String(ownerId) === viewerId;
    const name = profile?.name ?? 'Deleted account';
    const image = profile?.profile_image ?? '';

    return {
        _id: doc._id,
        podcast: doc.podcast,
        parent: doc.parent ?? null,
        text: doc.text,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        editedAt: doc.editedAt ?? null,
        isEdited: Boolean(doc.editedAt),
        commentor: {
            _id: doc.commentor,
            type: doc.commentorType,
            name,
            profile_image: image,
        },
        // Legacy flat fields (Flutter app).
        commentorName: name,
        commentorProfileImage: image,
        totalLike: likers.length,
        isLiked: likers.some((l) => String(l.likerId) === viewerId),
        totalReplies: doc.replyCount?.[0]?.n ?? 0,
        isMyComment,
        isAuthor: Boolean(ownerId) && String(doc.commentor) === String(ownerId),
        canDelete: isMyComment || isOwner || isAdmin(viewer),
    };
};

export type TCommentView = ReturnType<typeof toView>;

/** One page of comments matching `match`, plus pagination meta. */
const listComments = async (
    match: Record<string, any>,
    sort: Record<string, 1 | -1>,
    query: Record<string, any>,
    ctx: ViewContext
) => {
    const { page, limit, skip } = pagination(query);
    const [docs, total] = await Promise.all([
        Comment.aggregate([
            { $match: match },
            { $sort: { ...sort, _id: sort.createdAt ?? -1 } },
            { $skip: skip },
            { $limit: limit },
            ...decorateStages(),
        ]),
        Comment.countDocuments(match),
    ]);
    return {
        meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
        result: docs.map((d) => toView(d, ctx)),
    };
};

/** A single comment in the list shape (used after create/update). */
const getCommentView = async (id: Types.ObjectId, ctx: ViewContext) => {
    const [doc] = await Comment.aggregate([
        { $match: { _id: id } },
        ...decorateStages(),
    ]);
    if (!doc) throw new AppError(httpStatus.NOT_FOUND, 'Comment not found');
    return toView(doc, ctx);
};

/** In-app notification; never fails the request that triggered it. */
const notify = (receiver: Types.ObjectId | null | undefined, sender: string, title: string, message: string, podcastId: Types.ObjectId) => {
    if (!receiver || String(receiver) === sender) return;
    Notification.create({
        title,
        message,
        receiver: String(receiver),
        type: ENUM_NOTIFICATION_TYPE.COMMENT,
        redirectId: String(podcastId),
    }).catch(() => undefined);
};

const createComment = async (
    user: JwtPayload,
    payload: { podcast: string; text: string }
) => {
    const podcast = await findPodcastOwner(payload.podcast);
    const created = await Comment.create({
        podcast: podcast._id,
        text: payload.text,
        commentor: user.profileId,
        commentorType: commentorTypeOf(user),
        likers: [],
        parent: null,
    });
    const view = await getCommentView(created._id, { viewer: user, ownerId: podcast.creator });
    notify(
        podcast.creator,
        String(user.profileId),
        'New comment',
        `${view.commentor.name} commented on "${podcast.title ?? 'your podcast'}": ${payload.text.slice(0, 80)}`,
        podcast._id
    );
    return view;
};

const createReply = async (
    user: JwtPayload,
    payload: { parent: string; text: string }
) => {
    const parent = await Comment.findById(payload.parent)
        .select('podcast commentor')
        .lean<Pick<IComment, 'podcast' | 'commentor'> & { _id: Types.ObjectId }>();
    if (!parent) throw new AppError(httpStatus.NOT_FOUND, 'Parent comment not found');
    const podcast = await findPodcastOwner(parent.podcast);

    const created = await Comment.create({
        podcast: podcast._id,
        parent: parent._id,
        text: payload.text,
        commentor: user.profileId,
        commentorType: commentorTypeOf(user),
        likers: [],
    });
    const view = await getCommentView(created._id, { viewer: user, ownerId: podcast.creator });
    notify(
        parent.commentor,
        String(user.profileId),
        'New reply',
        `${view.commentor.name} replied to your comment: ${payload.text.slice(0, 80)}`,
        podcast._id
    );
    return view;
};

const updateComment = async (
    user: JwtPayload,
    id: string,
    payload: { text: string }
) => {
    // Only the text is editable; anything else in the body is ignored.
    const updated = await Comment.findOneAndUpdate(
        { _id: id, commentor: user.profileId },
        { $set: { text: payload.text, editedAt: new Date() } },
        { new: true, runValidators: true }
    ).lean<IComment & { _id: Types.ObjectId }>();
    if (!updated) {
        throw new AppError(
            httpStatus.NOT_FOUND,
            'Comment not found or you are not allowed to edit it'
        );
    }
    const podcast = await Podcast.findById(updated.podcast)
        .select('creator')
        .setOptions({ includeHidden: true })
        .lean<{ creator?: Types.ObjectId | null }>();
    return getCommentView(updated._id, { viewer: user, ownerId: podcast?.creator });
};

/** The given comments plus every reply under them, at any depth. */
const collectThreadIds = async (rootIds: Types.ObjectId[]) => {
    const all = [...rootIds];
    let frontier = rootIds;
    for (let depth = 0; frontier.length && depth < MAX_THREAD_DEPTH; depth++) {
        const children = await Comment.find({ parent: { $in: frontier } })
            .select('_id')
            .lean<{ _id: Types.ObjectId }[]>();
        frontier = children.map((c) => c._id);
        all.push(...frontier);
    }
    return all;
};

/**
 * Deletes a comment and its whole reply thread. Allowed for the author, the
 * creator of the podcast (moderation) and admins.
 */
const deleteComment = async (user: JwtPayload, id: string) => {
    const comment = await Comment.findById(id)
        .select('podcast commentor parent')
        .lean<Pick<IComment, 'podcast' | 'commentor' | 'parent'> & { _id: Types.ObjectId }>();
    if (!comment) throw new AppError(httpStatus.NOT_FOUND, 'Comment not found');

    let allowed = String(comment.commentor) === String(user.profileId) || isAdmin(user);
    if (!allowed && user.role === USER_ROLE.creator) {
        const podcast = await Podcast.findById(comment.podcast)
            .select('creator')
            .setOptions({ includeHidden: true })
            .lean<{ creator?: Types.ObjectId | null }>();
        allowed = Boolean(podcast?.creator) && String(podcast?.creator) === String(user.profileId);
    }
    if (!allowed) {
        throw new AppError(httpStatus.FORBIDDEN, 'You are not allowed to delete this comment');
    }

    const ids = await collectThreadIds([comment._id]);
    const { deletedCount } = await Comment.deleteMany({ _id: { $in: ids } });
    return { _id: comment._id, parent: comment.parent ?? null, deletedCount };
};

/**
 * Atomic like toggle: the filters make concurrent taps safe (a user can never
 * appear twice in `likers`). Likes don't touch `updatedAt`.
 */
const likeUnlikeComment = async (commentId: string, user: JwtPayload) => {
    const likerId = toObjectId(String(user.profileId));
    const options = { new: true, timestamps: false, projection: { likers: 1 } } as const;

    const unliked = await Comment.findOneAndUpdate(
        { _id: commentId, 'likers.likerId': likerId },
        { $pull: { likers: { likerId } } },
        options
    ).lean<IComment>();
    if (unliked) {
        return { commentId, liked: false, isLiked: false, totalLikes: unliked.likers.length };
    }

    const liked = await Comment.findOneAndUpdate(
        { _id: commentId, 'likers.likerId': { $ne: likerId } },
        { $push: { likers: { likerId, likerType: commentorTypeOf(user) } } },
        options
    ).lean<IComment>();
    if (liked) {
        return { commentId, liked: true, isLiked: true, totalLikes: liked.likers.length };
    }

    // Neither matched: the comment is gone, or a concurrent tap just liked it.
    const current = await Comment.findById(commentId).select('likers').lean<IComment>();
    if (!current) throw new AppError(httpStatus.NOT_FOUND, 'Comment not found');
    return { commentId, liked: true, isLiked: true, totalLikes: current.likers.length };
};

/** Top-level comments of a podcast, newest first. */
const getPodcastComments = async (
    user: JwtPayload,
    podcastId: string,
    query: Record<string, any>
) => {
    const podcast = await findPodcastOwner(podcastId);
    return listComments(
        { podcast: podcast._id, parent: null },
        { createdAt: -1 },
        query,
        { viewer: user, ownerId: podcast.creator }
    );
};

/** Direct replies of a comment, oldest first (reads as a conversation). */
const getReplies = async (
    user: JwtPayload,
    parentId: string,
    query: Record<string, any>
) => {
    const parent = await Comment.findById(parentId)
        .select('podcast')
        .lean<{ _id: Types.ObjectId; podcast: Types.ObjectId }>();
    if (!parent) throw new AppError(httpStatus.NOT_FOUND, 'Comment not found');
    const podcast = await Podcast.findById(parent.podcast)
        .select('creator')
        .lean<{ creator?: Types.ObjectId | null }>();
    if (!podcast) throw new AppError(httpStatus.NOT_FOUND, 'Podcast not found');
    return listComments(
        { parent: parent._id },
        { createdAt: 1 },
        query,
        { viewer: user, ownerId: podcast.creator }
    );
};

/** Called when podcasts are deleted. */
const deleteCommentsOfPodcasts = (podcastIds: (string | Types.ObjectId)[]) =>
    Comment.deleteMany({ podcast: { $in: podcastIds.map((id) => toObjectId(String(id))) } });

/** Called when an account is deleted: their comments (with threads) and their likes go. */
const deleteCommentsOfUser = async (profileId: string | Types.ObjectId) => {
    const id = toObjectId(String(profileId));
    const own = await Comment.find({ commentor: id }).select('_id').lean<{ _id: Types.ObjectId }[]>();
    if (own.length) {
        const ids = await collectThreadIds(own.map((c) => c._id));
        await Comment.deleteMany({ _id: { $in: ids } });
    }
    await Comment.updateMany(
        { 'likers.likerId': id },
        { $pull: { likers: { likerId: id } } },
        { timestamps: false }
    );
};

const CommentServices = {
    createComment,
    createReply,
    updateComment,
    deleteComment,
    likeUnlikeComment,
    getPodcastComments,
    getReplies,
    deleteCommentsOfPodcasts,
    deleteCommentsOfUser,
};
export default CommentServices;
