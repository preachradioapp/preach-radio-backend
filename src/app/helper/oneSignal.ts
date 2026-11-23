/* eslint-disable @typescript-eslint/no-explicit-any */
import config from '../config';

/** OneSignal accepts at most this many subscription ids per request. */
export const ONESIGNAL_MAX_RECIPIENTS = 2000;
const ENDPOINT = 'https://api.onesignal.com/notifications?c=push';
const TIMEOUT_MS = 10_000;

export interface PushMessage {
    playerIds: string[];
    title: string;
    message: string;
    /** Delivered to the app with the tap (deep link: entity, action, entityId, notificationId…). */
    data?: Record<string, unknown>;
}

export type PushResult =
    | { ok: true; invalidPlayerIds: string[] }
    | { ok: false; retryable: boolean; error: string; invalidPlayerIds: string[] };

export const isPushConfigured = () =>
    Boolean(config.oneSignal.app_id && config.oneSignal.api_key);

/** New App API keys use `Key …`; legacy REST keys use `Basic …`. */
const authHeader = (key: string) =>
    key.startsWith('os_v2_') ? `Key ${key}` : `Basic ${key}`;

/** Collect ids OneSignal reports as invalid/unsubscribed (field names differ between API versions). */
const invalidIdsFrom = (body: any): string[] => {
    const errors = body?.errors;
    if (!errors || Array.isArray(errors)) return [];
    return Object.entries(errors)
        .filter(([k, v]) => /invalid|unsubscribed/i.test(k) && Array.isArray(v))
        .flatMap(([, v]) => (v as unknown[]).map(String));
};

/**
 * Send one push to up to 2000 installs. Never throws: the outcome says whether a retry
 * makes sense (network, timeout, 429, 5xx) and which ids should be deactivated.
 */
export const sendPush = async ({ playerIds, title, message, data }: PushMessage): Promise<PushResult> => {
    if (!isPushConfigured()) return { ok: false, retryable: false, error: 'OneSignal is not configured', invalidPlayerIds: [] };
    if (!playerIds.length) return { ok: true, invalidPlayerIds: [] };
    if (playerIds.length > ONESIGNAL_MAX_RECIPIENTS) throw new Error(`sendPush: at most ${ONESIGNAL_MAX_RECIPIENTS} ids per call`);

    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: authHeader(config.oneSignal.api_key as string),
            },
            body: JSON.stringify({
                app_id: config.oneSignal.app_id,
                target_channel: 'push',
                include_subscription_ids: playerIds,
                headings: { en: title },
                contents: { en: message },
                data,
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body: any = await res.json().catch(() => ({}));
        const invalidPlayerIds = invalidIdsFrom(body);

        if (res.ok) {
            // 200 with "All included players are not subscribed" still means: nothing to retry.
            return { ok: true, invalidPlayerIds };
        }
        const retryable = res.status === 429 || res.status >= 500;
        const error = `OneSignal ${res.status}: ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`;
        return { ok: false, retryable, error, invalidPlayerIds };
    } catch (e: any) {
        return { ok: false, retryable: true, error: `OneSignal request failed: ${e?.message ?? e}`, invalidPlayerIds: [] };
    }
};
