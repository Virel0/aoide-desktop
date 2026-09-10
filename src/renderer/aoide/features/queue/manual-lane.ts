/**
 * The manual lane: the songs the listener queued themselves, kept together and
 * kept ahead of whatever album or playlist is running.
 *
 * Ported from the phone's `PlayQueue` so both apps behave the same way, and
 * pure for the same reason it is pure there: every rule below is easy to get
 * subtly wrong and impossible to test through the player.
 *
 * The one rule everything else follows from: **the lane is a run, not a set.**
 * It is the manual entries sitting *immediately* after the current track. A
 * queued song that has played falls behind the playhead and leaves the lane on
 * its own, so nothing ever has to tidy up after it.
 *
 * The desktop keeps two orders — `queue.default`, which is what the queue view
 * shows, and `queue.shuffled`, a permutation of indexes into it that playback
 * follows. Every function here is generic over the element type so the same
 * rule can be applied to both: ids in one, indexes in the other.
 */

/** Whether an entry got here by Play Next or Play Last rather than as part of a context. */
export type ManualPredicate<T> = (item: T) => boolean;

/** The display order, and the playback order as indexes into it. */
export interface QueueOrder {
    order: string[];
    /** Empty when shuffle is off, in which case playback follows `order`. */
    shuffled: number[];
}

/**
 * One labelled run of rows in the queue view.
 *
 * `start` is an index into the queue as the view has it, so a section knows
 * where it sits in the whole rather than only how long it is.
 */
export interface QueueSection {
    count: number;
    kind: QueueSectionKind;
    /** An `aoide.queue.*` key. Chosen here rather than in markup so it can be tested. */
    labelKey: string;
    start: number;
}

export type QueueSectionKind = 'context' | 'lane' | 'played' | 'playing';

/** A shuffle. Taken as an argument so tests can pin an order instead of hoping. */
export type Shuffle<T> = (items: T[]) => T[];

/**
 * Insert entries into both orders at once, keeping the permutation valid.
 *
 * Every index in `shuffled` at or after the insertion point shifts along, and
 * the new entries are spliced into playback at `playbackAt` in the order given
 * — *not* shuffled among themselves. Scattering the three songs somebody just
 * chose is the thing the lane exists to prevent, and doing it only in the
 * playback order would make the queue view a lie about what plays next.
 *
 * An empty `shuffled` is left empty: with shuffle off there is no permutation
 * to maintain.
 */
export const insertEntries = (
    queue: QueueOrder,
    ids: readonly string[],
    at: number,
    playbackAt: number,
): QueueOrder => {
    if (ids.length === 0) {
        return { order: [...queue.order], shuffled: [...queue.shuffled] };
    }

    const boundedAt = clamp(at, 0, queue.order.length);
    const order = [...queue.order.slice(0, boundedAt), ...ids, ...queue.order.slice(boundedAt)];

    if (queue.shuffled.length === 0) {
        return { order, shuffled: [] };
    }

    const adjusted = queue.shuffled.map((index) =>
        index >= boundedAt ? index + ids.length : index,
    );
    const inserted = ids.map((_, offset) => boundedAt + offset);
    const boundedPlaybackAt = clamp(playbackAt, 0, adjusted.length);

    return {
        order,
        shuffled: [
            ...adjusted.slice(0, boundedPlaybackAt),
            ...inserted,
            ...adjusted.slice(boundedPlaybackAt),
        ],
    };
};

/**
 * How many manual entries sit in the run immediately after the current one.
 *
 * Zero when nothing is playing: with no playhead there is nothing for a lane
 * to sit in front of.
 */
export const laneLength = <T>(
    items: readonly T[],
    currentPosition: number,
    isManual: ManualPredicate<T>,
): number => {
    if (!hasCurrent(items, currentPosition)) return 0;

    let length = 0;
    for (let index = currentPosition + 1; index < items.length; index++) {
        if (!isManual(items[index])) break;
        length++;
    }
    return length;
};

/**
 * Where Play Last inserts: just past the lane, not the end of the queue.
 *
 * The end of the queue is the wrong place and always was — asking for a song
 * while a twenty-track album is running used to mean hearing it in an hour. It
 * goes after everything else queued by hand, and before the album picks up
 * again.
 *
 * With nothing playing this is the end of the queue, which is what makes
 * adding to an empty queue behave exactly as it did before.
 */
export const laneEnd = <T>(
    items: readonly T[],
    currentPosition: number,
    isManual: ManualPredicate<T>,
): number => {
    if (!hasCurrent(items, currentPosition)) return items.length;
    return currentPosition + 1 + laneLength(items, currentPosition, isManual);
};

/**
 * The lane itself.
 *
 * Also what survives starting something else: picking a new album is a
 * statement about the album, not a decision to throw away the three songs
 * somebody lined up a minute ago. Entries that have already played are not in
 * the run, so they are not carried over — they have had their turn.
 */
export const laneItems = <T>(
    items: readonly T[],
    currentPosition: number,
    isManual: ManualPredicate<T>,
): T[] => {
    if (!hasCurrent(items, currentPosition)) return [];
    return items.slice(
        currentPosition + 1,
        currentPosition + 1 + laneLength(items, currentPosition, isManual),
    );
};

/**
 * The playback order to use when shuffle is switched on: the current track,
 * then the lane, then everything else in a random order.
 *
 * The lane is not shuffled. Somebody who queued three songs and then hit
 * shuffle meant "surprise me afterwards", not "scatter the three things I just
 * chose".
 */
export const playbackOrderKeepingLane = <T>(
    items: readonly T[],
    currentPosition: number,
    isManual: ManualPredicate<T>,
    shuffle: Shuffle<T>,
): T[] => {
    if (!hasCurrent(items, currentPosition)) return shuffle([...items]);

    const lane = laneItems(items, currentPosition, isManual);
    const end = currentPosition + 1 + lane.length;
    const rest = [...items.slice(0, currentPosition), ...items.slice(end)];

    return [items[currentPosition], ...lane, ...shuffle(rest)];
};

/**
 * A re-shuffle: the current track and its lane stay exactly where they are and
 * only what follows them is shuffled. Anything already behind the playhead is
 * left alone — it is history, and reordering it changes nothing anybody hears.
 */
export const shuffleAfterLane = <T>(
    items: readonly T[],
    currentPosition: number,
    isManual: ManualPredicate<T>,
    shuffle: Shuffle<T>,
): T[] => {
    if (!hasCurrent(items, currentPosition)) return [...items];

    const end = laneEnd(items, currentPosition, isManual);
    return [...items.slice(0, end), ...shuffle(items.slice(end))];
};

/**
 * The queue view's sections, in the order they are shown.
 *
 * Named to match the phone: what you chose yourself plays before whatever was
 * already running resumes, and the label says so. With no lane there is
 * nothing to distinguish, so the rest is plainly "Up Next" rather than "Then".
 *
 * Empty sections are left out — a heading over nothing is a heading that has
 * to be explained. The counts always add up to `items.length`, because the
 * table builds its rows by walking the sections in order.
 */
export const queueSections = <T>(
    items: readonly T[],
    currentPosition: number,
    isManual: ManualPredicate<T>,
): QueueSection[] => {
    if (items.length === 0) return [];

    if (!hasCurrent(items, currentPosition)) {
        return [{ count: items.length, kind: 'context', labelKey: 'aoide.queue.upNext', start: 0 }];
    }

    const lane = laneLength(items, currentPosition, isManual);
    const contextStart = currentPosition + 1 + lane;

    const sections: QueueSection[] = [
        { count: currentPosition, kind: 'played', labelKey: 'aoide.queue.played', start: 0 },
        {
            count: 1,
            kind: 'playing',
            labelKey: 'aoide.queue.nowPlaying',
            start: currentPosition,
        },
        {
            count: lane,
            kind: 'lane',
            labelKey: 'aoide.queue.nextUp',
            start: currentPosition + 1,
        },
        {
            count: items.length - contextStart,
            kind: 'context',
            labelKey: lane > 0 ? 'aoide.queue.then' : 'aoide.queue.upNext',
            start: contextStart,
        },
    ];

    return sections.filter((section) => section.count > 0);
};

/**
 * How many section headings a given row of data has above it.
 *
 * The virtualised table inserts one row per section, so a data index and a row
 * index are not the same number — and scrolling to "the track that just
 * started" by its data index lands on the wrong row by exactly this much. The
 * phone shipped the same bug the other way round, with drag offsets measured
 * against the wrong base, which is why this is a function with a test rather
 * than an addition written at each call site.
 */
export const sectionHeaderRowsBefore = (
    dataIndex: number,
    sectionCounts: readonly number[],
): number => {
    let seen = 0;
    let headers = 0;

    for (const count of sectionCounts) {
        if (dataIndex < seen) break;
        headers++;
        seen += count;
    }

    return headers;
};

/**
 * Where the current entry sits in the display order.
 *
 * Playback follows `shuffled` when shuffle is on and `order` when it is off,
 * so a single "where am I" needs the permutation applied — or not — depending.
 * Every caller below takes the playback position for the same reason: it is
 * the one the player actually holds.
 */
export const currentIndexInOrder = (queue: QueueOrder, playbackPosition: number): number => {
    if (queue.shuffled.length === 0) return playbackPosition;
    if (playbackPosition < 0 || playbackPosition >= queue.shuffled.length) return -1;
    return queue.shuffled[playbackPosition];
};

/**
 * Play Next: the front of the lane, ahead of anything queued earlier.
 */
export const playNext = (
    queue: QueueOrder,
    ids: readonly string[],
    playbackPosition: number,
): QueueOrder =>
    insertEntries(
        queue,
        ids,
        currentIndexInOrder(queue, playbackPosition) + 1,
        playbackPosition + 1,
    );

/**
 * Play Last: the back of the lane. See ``laneEnd`` for why that is not the
 * back of the queue.
 */
export const playLast = (
    queue: QueueOrder,
    ids: readonly string[],
    playbackPosition: number,
    isManual: ManualPredicate<string>,
): QueueOrder => {
    const current = currentIndexInOrder(queue, playbackPosition);
    const at = laneEnd(queue.order, current, isManual);
    const playbackAt =
        queue.shuffled.length === 0
            ? at
            : laneEnd(queue.shuffled, playbackPosition, (index) => isManual(queue.order[index]));

    return insertEntries(queue, ids, at, playbackAt);
};

/** The lane as ids, which is what starting a new context carries over. */
export const laneAfterCurrent = (
    queue: QueueOrder,
    playbackPosition: number,
    isManual: ManualPredicate<string>,
): string[] =>
    queue.shuffled.length === 0
        ? laneItems(queue.order, playbackPosition, isManual)
        : laneItems(queue.shuffled, playbackPosition, (index) => isManual(queue.order[index])).map(
              (index) => queue.order[index],
          );

const clamp = (value: number, low: number, high: number): number =>
    Math.min(Math.max(value, low), high);

const hasCurrent = <T>(items: readonly T[], currentPosition: number): boolean =>
    currentPosition >= 0 && currentPosition < items.length;
