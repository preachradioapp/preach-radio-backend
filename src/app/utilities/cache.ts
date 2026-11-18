import redis from './redisClient';
import { errorLogger } from '../shared/logger';

/**
 * Deletes every key matching `pattern` using SCAN (non-blocking).
 * `redis.keys()` walks the whole keyspace in one blocking call and stalls every
 * other Redis client while it runs, so it must not be used on request paths.
 *
 * Cache invalidation must never fail the write that triggered it, so errors are
 * logged and swallowed.
 */
export const deleteByPattern = async (pattern: string): Promise<void> => {
    try {
        const stream = redis.scanStream({ match: pattern, count: 200 });
        const pending: Promise<number>[] = [];
        for await (const keys of stream) {
            if ((keys as string[]).length) {
                pending.push(redis.unlink(...(keys as string[])));
            }
        }
        await Promise.all(pending);
    } catch (err) {
        errorLogger.error(`Cache invalidation failed for "${pattern}"`, err);
    }
};

export const deleteKeys = async (...keys: string[]): Promise<void> => {
    if (!keys.length) return;
    try {
        await redis.unlink(...keys);
    } catch (err) {
        errorLogger.error(
            `Cache invalidation failed for ${keys.join(', ')}`,
            err
        );
    }
};

/** Per-user caches used by the podcast feed. */
export const userCacheKeys = {
    likes: (profileId: string) => `likes:${profileId}`,
    bookmarks: (profileId: string) => `bookmarks:${profileId}`,
};
