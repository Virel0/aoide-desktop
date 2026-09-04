import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';

/**
 * The half of "not interested" that the renderer applies.
 *
 * Mixes are narrowed in the main process, where `Mix.narrow` drops hidden
 * tracks before any rule sees them. Everything else that *offers* music from
 * the renderer — a station re-seeded from Jellyfin's instant mix, a radio —
 * gets its list from Jellyfin, which knows nothing about the flag, and filters
 * it through here before it reaches the queue. Ordinary playlists and albums
 * never come through: the flag is about what the app offers, not what the
 * person asks for.
 */

/** `items` without the ones in `hidden`, in the order given. Pure. */
export const withoutNotInterested = <T extends { id: string }>(
    items: readonly T[],
    hidden: ReadonlySet<string>,
): T[] => (hidden.size === 0 ? [...items] : items.filter((item) => !hidden.has(item.id)));

/**
 * `items` without the tracks marked not interested, asked of the store in one
 * call for the whole list. A build with no store — the web build — offers
 * everything, which is what it did before there were flags.
 */
export const dropNotInterested = async <T extends { id: string }>(
    items: readonly T[],
): Promise<T[]> => {
    if (items.length === 0 || !isAoideAvailable()) return [...items];

    const hidden = await window.api.aoide.flags.notInterestedAmong(items.map((item) => item.id));
    return withoutNotInterested(items, new Set(hidden));
};
