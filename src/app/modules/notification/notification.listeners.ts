import { onAppEvent } from '../../events/appEvents';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import { USER_ROLE } from '../user/user.constant';
import { NOTIFICATION_ENTITY } from './notification.interface';
import notificationService from './notification.services';

const { notifySafe } = notificationService;
const short = (text: string, max = 120) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Domain events → inbox + push. Imported once at startup (app.ts). */

onAppEvent('comment.created', (e) => {
    if (!e.podcastOwnerId || e.podcastOwnerId === e.actorId) return;
    return notifySafe({
        receiver: e.podcastOwnerId,
        type: ENUM_NOTIFICATION_TYPE.COMMENT,
        title: 'New comment',
        message: `${e.actorName} commented on “${short(e.podcastTitle, 60)}”: ${short(e.text, 80)}`,
        data: { entity: NOTIFICATION_ENTITY.PODCAST, entityId: e.podcastId, meta: { commentId: e.commentId } },
    });
});

onAppEvent('comment.replied', (e) => {
    if (e.parentAuthorId === e.actorId) return;
    return notifySafe({
        receiver: e.parentAuthorId,
        type: ENUM_NOTIFICATION_TYPE.COMMENT,
        title: 'New reply',
        message: `${e.actorName} replied to your comment: ${short(e.text, 80)}`,
        data: { entity: NOTIFICATION_ENTITY.PODCAST, entityId: e.podcastId, meta: { commentId: e.commentId } },
    });
});

onAppEvent('live.invited', (e) =>
    notifySafe({
        receiver: e.invitedProfileId,
        type: ENUM_NOTIFICATION_TYPE.LIVE_INVITATION,
        title: 'Live invitation',
        message: `${e.hostName ?? 'A host'} invited you to join “${short(e.roomName, 60)}”`,
        data: { entity: NOTIFICATION_ENTITY.LIVE_ROOM, entityId: e.roomId },
    })
);

onAppEvent('feedback.replied', (e) =>
    notifySafe({
        receiver: e.profileId,
        type: ENUM_NOTIFICATION_TYPE.FEEDBACK,
        title: 'Support replied',
        message: short(e.reply),
        data: { entity: NOTIFICATION_ENTITY.FEEDBACK, entityId: e.feedbackId },
    })
);

onAppEvent('creator.approved', (e) =>
    notifySafe({
        receiver: e.creatorId,
        type: ENUM_NOTIFICATION_TYPE.CREATOR_APPROVED,
        title: 'You’re approved 🎉',
        message: 'Your creator account is approved. You can now upload messages and go live.',
        data: { entity: NOTIFICATION_ENTITY.CREATOR, entityId: e.creatorId },
    })
);

onAppEvent('report.created', (e) =>
    notifySafe({
        receiver: USER_ROLE.superAdmin,
        type: ENUM_NOTIFICATION_TYPE.REPORT,
        title: 'New report',
        message: e.reason ? `A profile was reported: ${short(e.reason, 80)}` : 'A profile was reported.',
        data: { entity: NOTIFICATION_ENTITY.REPORT, entityId: e.reportId },
    })
);
