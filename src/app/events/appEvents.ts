import { EventEmitter } from 'events';
import { errorLogger } from '../shared/logger';

/**
 * Domain events. Services emit what happened; listeners (e.g. notifications) react, so the
 * service doesn't depend on who listens. Payloads are typed here — add an event by adding a key.
 */
export interface AppEvents {
    'comment.created': { podcastId: string; podcastTitle: string; podcastOwnerId?: string | null; commentId: string; actorId: string; actorName: string; text: string };
    'comment.replied': { podcastId: string; parentAuthorId: string; commentId: string; actorId: string; actorName: string; text: string };
    'live.invited': { roomId: string; roomName: string; invitedProfileId: string; hostName?: string };
    'feedback.replied': { feedbackId: string; profileId: string; reply: string };
    'creator.approved': { creatorId: string };
    'report.created': { reportId: string; reason?: string };
}

// eslint-disable-next-line no-unused-vars -- a type parameter name, not a variable
type Handler<K extends keyof AppEvents> = (payload: AppEvents[K]) => unknown | Promise<unknown>;

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

/**
 * Listen safely: a throwing or rejecting handler is logged and never crashes the process or
 * the request that emitted the event (Node's EventEmitter does neither by itself).
 */
export const onAppEvent = <K extends keyof AppEvents>(event: K, handler: Handler<K>) => {
    emitter.on(event, (payload: AppEvents[K]) => {
        try {
            Promise.resolve(handler(payload)).catch((err) => errorLogger.error(`Listener for "${event}" failed`, err));
        } catch (err) {
            errorLogger.error(`Listener for "${event}" failed`, err);
        }
    });
};

/** Fire-and-forget. Listeners run after the current request's work; they must persist what matters. */
export const emitAppEvent = <K extends keyof AppEvents>(event: K, payload: AppEvents[K]) => {
    emitter.emit(event, payload);
};
