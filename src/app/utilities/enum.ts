export const ENUM_PRODUCT_STATUS = {
    AVAILABLE: 'available',
    UNAVAILABLE: 'unavailable',
} as const;

export const ENUM_USER_STATUS = {
    IN_PROGRESS: 'in-progress',
    BLOCKED: 'blocked',
};

export const ENUM_NOTIFICATION_TYPE = {
    /** Admin announcement (broadcast). */
    GENERAL: 'GENERAL',
    /** Someone commented on your podcast / replied to your comment. */
    COMMENT: 'COMMENT',
    /** A host invited you into a live room. */
    LIVE_INVITATION: 'LIVE_INVITATION',
    /** Support answered your message. */
    FEEDBACK: 'FEEDBACK',
    /** Your creator application was approved. */
    CREATOR_APPROVED: 'CREATOR_APPROVED',
    /** Admin: a user reported a profile. */
    REPORT: 'REPORT',
    PAYMENT: 'PAYMENT',
    // Legacy values from the project template; kept so old rows still validate.
    COURSE: 'COURSE',
    CLASS: 'CLASS',
    ORDER: 'ORDER',
} as const;

export const ENUM_PAYMENT_STATUS = {
    PAID: 'PAID',
    UNPAID: 'UNPAID',
};

export const ENUM_INCIDENT_TYPE = {
    UNPROFESSIONAL_BEHAVIOR: 'Unprofessional Behavior',
    FAILURE_TO_COLLABORATE: 'Failure to collaborate',
    SPAM: 'Spam',
    OTHER: 'Other',
};
