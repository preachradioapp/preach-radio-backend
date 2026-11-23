import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import notificationService from './notification.services';

const ok = (message: string) => ({ statusCode: 200, success: true, message });

const getAllNotification = catchAsync(async (req, res) => {
    const result = await notificationService.getAllNotificationFromDB(req.query, req.user);
    sendResponse(res, { ...ok('Notification retrieved successfully'), data: result });
});

const getUnseenCount = catchAsync(async (req, res) => {
    const result = await notificationService.getUnseenCount(req.user);
    sendResponse(res, { ...ok('Unseen notification count retrieved successfully'), data: result });
});

const seeNotification = catchAsync(async (req, res) => {
    const result = await notificationService.seeNotification(req.user);
    sendResponse(res, { ...ok('Notifications marked as read'), data: result });
});

const seeSingleNotification = catchAsync(async (req, res) => {
    const result = await notificationService.seeSingleNotification(req.params.id, req.user);
    sendResponse(res, { ...ok('Notification marked as read'), data: result });
});

const deleteNoficiation = catchAsync(async (req, res) => {
    const result = await notificationService.deleteNoficiation(req.params.id, String(req.user.profileId), req.user.role);
    sendResponse(res, { ...ok('Notification deleted successfully'), data: result });
});

const createBroadcast = catchAsync(async (req, res) => {
    const result = await notificationService.createBroadcast(req.body, String(req.user.profileId ?? req.user.id));
    sendResponse(res, { statusCode: 202, success: true, message: 'Announcement queued; it is being delivered', data: result });
});

const getBroadcasts = catchAsync(async (req, res) => {
    const result = await notificationService.getBroadcasts(req.query);
    sendResponse(res, { ...ok('Announcements retrieved successfully'), data: result });
});

const notificationController = {
    getAllNotification,
    getUnseenCount,
    seeNotification,
    seeSingleNotification,
    deleteNoficiation,
    createBroadcast,
    getBroadcasts,
};
export default notificationController;
