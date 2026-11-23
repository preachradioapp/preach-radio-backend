import { model, Schema, Types } from 'mongoose';

export const DEVICE_PLATFORMS = ['ios', 'android', 'web'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export interface IDevice {
    /** Profile id (NormalUser / Creator), the same id notifications use as `receiver`. */
    profileId: Types.ObjectId;
    role: string;
    /** OneSignal subscription id (a.k.a. player id) of this app install. */
    playerId: string;
    platform: DevicePlatform;
    /** false after logout, or when OneSignal reports the id invalid. */
    isActive: boolean;
    lastSeenAt: Date;
}

const deviceSchema = new Schema<IDevice>(
    {
        profileId: { type: Schema.Types.ObjectId, required: true },
        role: { type: String, required: true },
        playerId: { type: String, required: true, trim: true },
        platform: { type: String, enum: DEVICE_PLATFORMS, required: true },
        isActive: { type: Boolean, default: true },
        lastSeenAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

// One install belongs to one account at a time (a re-login moves it).
deviceSchema.index({ playerId: 1 }, { unique: true });
// "Active devices of these users" for push delivery.
deviceSchema.index({ profileId: 1, isActive: 1 });

export const Device = model<IDevice>('Device', deviceSchema);
