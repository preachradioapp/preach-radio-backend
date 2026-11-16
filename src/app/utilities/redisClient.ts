import Redis from 'ioredis';
import { errorLogger } from '../shared/logger';

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD || undefined,
});

// Without a listener, ioredis's 'error' event is unhandled and crashes the
// whole process on any connection hiccup (not just cache calls).
redis.on('error', (err) => {
    errorLogger.error('Redis client error:', err);
});

export default redis;
