import type { FinishCounts } from '/@/shared/aoide/finish-rate';
import type { TasteProfile } from '/@/shared/aoide/taste-ranking';

import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { logger } from '/@/renderer/utils/logger';
import { emptyTasteProfile, parseTasteProfile } from '/@/shared/aoide/taste-ranking';

/**
 * The two reads Infinity makes of the curation store before it chooses.
 *
 * Kept apart from `infinity-taste.ts` so the choosing stays a pure module with
 * nothing of the renderer in it: this file is the process boundary, and the
 * boundary is where an answer stops being somebody else's object and becomes a
 * profile. Both reads answer with nothing rather than throwing — Infinity's job
 * is to keep the music going, and "no history" is a real state a new install is
 * in, not an error.
 */

/**
 * How far back the profile reads.
 *
 * Taste moves; a year of listening describes somebody who no longer exists.
 * The phone's window, so a listener who uses both is offered the same music.
 */
export const INFINITY_TASTE_WINDOW_DAYS = 90;

/**
 * Starts and finishes for a whole pool, in one crossing of the bridge.
 *
 * Empty when there is no store to ask, which the ranking reads as "nothing is
 * known about any of these" rather than as "none of these were ever finished".
 */
export const readFinishCounts = async (
    ids: readonly string[],
): Promise<Record<string, FinishCounts>> => {
    if (ids.length === 0 || !isAoideAvailable()) return {};

    try {
        return await window.api.aoide.history.finishRates([...ids]);
    } catch (error) {
        logger.warn('Infinity could not read finish rates', { error: (error as Error).message });
        return {};
    }
};

/**
 * The listener's profile, over the last ninety days.
 *
 * An empty profile rather than a throw for every way of not having one — the
 * web build with no store at all, a database that failed to open, a query that
 * went wrong. The worst honest answer here is the behaviour Auto DJ had before
 * the profile existed, which is what an empty profile produces.
 */
export const readTasteProfile = async (): Promise<TasteProfile> => {
    if (!isAoideAvailable()) return emptyTasteProfile();

    const since = Date.now() - INFINITY_TASTE_WINDOW_DAYS * MS_PER_DAY;

    try {
        return parseTasteProfile(await window.api.aoide.history.tasteProfile(since));
    } catch (error) {
        logger.warn('Infinity could not read the taste profile', {
            error: (error as Error).message,
        });
        return emptyTasteProfile();
    }
};

/**
 * What this device heard lately, newest first — the order the sidecar's
 * `recent` wants, which the profile's own set has thrown away. The same read
 * as the profile (the wire form keeps the order); empty for every way of
 * having nothing, as above.
 */
export const readRecentlyPlayed = async (): Promise<string[]> => {
    if (!isAoideAvailable()) return [];

    const since = Date.now() - INFINITY_TASTE_WINDOW_DAYS * MS_PER_DAY;

    try {
        const wire = await window.api.aoide.history.tasteProfile(since);
        return Array.isArray(wire.recent)
            ? wire.recent.filter((id): id is string => typeof id === 'string')
            : [];
    } catch (error) {
        logger.warn('Infinity could not read what was heard lately', {
            error: (error as Error).message,
        });
        return [];
    }
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
