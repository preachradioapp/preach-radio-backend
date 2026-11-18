/* eslint-disable @typescript-eslint/no-explicit-any */
import { MediaConvertClient } from '@aws-sdk/client-mediaconvert';
import {
    DeleteObjectsCommand,
    ListObjectsV2Command,
    S3Client,
} from '@aws-sdk/client-s3';
import { mediaConfig } from './media.config';

/** Anything with the SDK's `send(command)` shape — lets tests swap in fakes. */
// eslint-disable-next-line no-unused-vars -- parameter name in a type, not a variable
export type CommandSender = { send: (command: any) => Promise<any> };

let mediaConvertClient: MediaConvertClient | undefined;
let s3Client: S3Client | undefined;
const overrides: { mediaConvert?: CommandSender; s3?: CommandSender } = {};

// Credentials come from the SDK's default chain: AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY in the environment, as for the rest of the backend.
export const getMediaConvert = (): CommandSender => {
    if (overrides.mediaConvert) return overrides.mediaConvert;
    if (!mediaConvertClient) {
        const { region, endpoint } = mediaConfig();
        mediaConvertClient = new MediaConvertClient({ region, endpoint });
    }
    return mediaConvertClient;
};

export const getS3 = (): CommandSender => {
    if (overrides.s3) return overrides.s3;
    if (!s3Client) s3Client = new S3Client({ region: mediaConfig().region });
    return s3Client;
};

/** Test hook: replace the AWS clients with fakes (pass `{}` to restore). */
export const setMediaClients = (clients: {
    mediaConvert?: CommandSender;
    s3?: CommandSender;
}) => {
    overrides.mediaConvert = clients.mediaConvert;
    overrides.s3 = clients.s3;
};

/**
 * Deletes every object under `prefix` (e.g. "media/<id>/<run>/").
 * Refuses short or rootless prefixes so a bug can never empty the bucket.
 */
export const deleteS3Prefix = async (prefix: string) => {
    if (!/^media\/[a-f0-9]{24}\/(.+\/)?$/.test(prefix)) {
        throw new Error(`Refusing to delete unexpected prefix "${prefix}"`);
    }
    const { bucket } = mediaConfig();
    const s3 = getS3();
    let token: string | undefined;
    let deleted = 0;
    do {
        const page = await s3.send(
            new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: token,
            })
        );
        const keys = (page.Contents ?? [])
            .map((o: { Key?: string }) => o.Key)
            .filter(Boolean);
        if (keys.length) {
            await s3.send(
                new DeleteObjectsCommand({
                    Bucket: bucket,
                    Delete: {
                        Objects: keys.map((Key: string) => ({ Key })),
                        Quiet: true,
                    },
                })
            );
            deleted += keys.length;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
};
