import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import deviceService from './device.service';

const registerDevice = catchAsync(async (req, res) => {
    await deviceService.registerDevice(
        String(req.user.profileId),
        req.user.role,
        req.body.playerId,
        req.body.platform
    );
    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Device registered for notifications',
        data: null,
    });
});

const unregisterDevice = catchAsync(async (req, res) => {
    await deviceService.unregisterDevice(
        String(req.user.profileId),
        req.body.playerId
    );
    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Device unregistered',
        data: null,
    });
});

const deviceController = { registerDevice, unregisterDevice };
export default deviceController;
