/** Preach Clips (reels) may be at most 2 minutes long. */
export const CLIP_MAX_SECONDS = 120;

/**
 * Which podcasts count as clips (reels).
 *
 * New and edited content is classified explicitly with `type: 'clip'`.
 * Records created before `type` existed have no `type` field; for those we keep
 * the duration rule each screen already used (`legacyMaxDuration`), so old data
 * shows up exactly where it did before.
 */
export const clipFilter = (legacyMaxDuration = 60) => ({
    $or: [
        { type: 'clip' },
        { type: { $exists: false }, duration: { $lte: legacyMaxDuration } },
    ],
});

/** Full episodes: everything that is not a clip under the same rules. */
export const episodeFilter = (legacyMaxDuration = 60) => ({
    $nor: clipFilter(legacyMaxDuration).$or,
});

/**
 * Builds the type filter from list query params.
 *   ?type=clip | ?type=episode   (new)
 *   ?reels=1                     (existing apps; same as type=clip)
 */
export const typeFilterFromQuery = (
    query: Record<string, unknown>,
    legacyMaxDuration = 60
) => {
    if (query.type === 'clip' || query.reels)
        return clipFilter(legacyMaxDuration);
    if (query.type === 'episode') return episodeFilter(legacyMaxDuration);
    return null;
};
