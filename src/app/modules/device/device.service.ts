import { Types } from 'mongoose';
import { Device, DevicePlatform } from './device.model';

/** Most recent active installs kept per account (older ones stop receiving push). */
export const MAX_ACTIVE_DEVICES = 10;

/**
 * Register (or move) this install for the signed-in account. Idempotent: the app calls it
 * on every launch / login. A device that belonged to someone else now belongs to this user.
 */
const registerDevice = async (
    profileId: string,
    role: string,
    playerId: string,
    platform: DevicePlatform
) => {
    const device = await Device.findOneAndUpdate(
        { playerId },
        {
            $set: {
                profileId: new Types.ObjectId(profileId),
                role,
                platform,
                isActive: true,
                lastSeenAt: new Date(),
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Cap active installs: keep the newest MAX_ACTIVE_DEVICES.
    const stale = await Device.find({ profileId: device.profileId, isActive: true })
        .sort({ lastSeenAt: -1 })
        .skip(MAX_ACTIVE_DEVICES)
        .select('_id')
        .lean();
    if (stale.length) {
        await Device.updateMany(
            { _id: { $in: stale.map((d) => d._id) } },
            { $set: { isActive: false } }
        );
    }
    return device;
};

/** Logout on this install: stop pushes to it (only if it is this user's). */
const unregisterDevice = async (profileId: string, playerId: string) => {
    await Device.updateOne(
        { playerId, profileId: new Types.ObjectId(profileId) },
        { $set: { isActive: false } }
    );
    return null;
};

/** Active subscription ids for these profiles (push delivery). */
const activePlayerIds = async (profileIds: (string | Types.ObjectId)[]) => {
    const ids = profileIds
        .filter((id) => Types.ObjectId.isValid(String(id)))
        .map((id) => new Types.ObjectId(String(id)));
    if (!ids.length) return [];
    const devices = await Device.find({ profileId: { $in: ids }, isActive: true })
        .select('playerId')
        .lean();
    return devices.map((d) => d.playerId);
};

/** OneSignal said these ids are gone (app uninstalled / unsubscribed). */
const deactivatePlayerIds = async (playerIds: string[]) => {
    if (!playerIds.length) return;
    await Device.updateMany(
        { playerId: { $in: playerIds } },
        { $set: { isActive: false } }
    );
};

/** Account deleted. */
const deleteDevicesOfUser = (profileId: string) =>
    Device.deleteMany({ profileId: new Types.ObjectId(profileId) });

const deviceService = {
    registerDevice,
    unregisterDevice,
    activePlayerIds,
    deactivatePlayerIds,
    deleteDevicesOfUser,
};
export default deviceService;
