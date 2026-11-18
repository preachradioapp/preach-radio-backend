/**
 * Escapes user input so it is matched literally inside a MongoDB `$regex`
 * (prevents regex injection / catastrophic backtracking from search boxes).
 */
export const escapeRegex = (value: unknown): string =>
    String(Array.isArray(value) ? value[0] ?? '' : value ?? '').replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
    );

/**
 * Removes query-string values that would be interpreted as MongoDB operators,
 * e.g. `?email[$ne]=x` or `?$where=...`. Only plain scalar filters survive.
 */
export const sanitizeFilter = (
    query: Record<string, unknown>
): Record<string, unknown> => {
    const clean: Record<string, unknown> = {};
    Object.entries(query).forEach(([key, value]) => {
        if (key.startsWith('$') || key.includes('.')) return;
        if (value !== null && typeof value === 'object') return;
        clean[key] = value;
    });
    return clean;
};
