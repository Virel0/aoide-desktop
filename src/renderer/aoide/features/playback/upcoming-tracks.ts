/**
 * The tracks about to play, in the order they will, so their measurements
 * can be asked for before they are needed.
 *
 * Pure over the queue store's own shape: `default` is the queue in the order
 * it is shown, `shuffled` is the order it is played when shuffle is on (each
 * entry an index into `default`), and `index` is where playback is in
 * whichever of those is in force. Ids come back as the library's, which is
 * what the sidecar is asked about, not the queue's own unique ids.
 */
export interface QueueShape {
    /** `player.index`: the position in the playing order. */
    index: number;
    /** Whether `shuffled` is the playing order. */
    shuffle: boolean;
    shuffled: number[];
    /** Every queue song by its `_uniqueId`, with the library id inside. */
    songs: Record<string, undefined | { id: string }>;
    unique: string[];
}

/** How far ahead the grids and arrangements are asked for. */
export const UPCOMING_COUNT = 8;

export const upcomingTrackIds = (queue: QueueShape, count: number = UPCOMING_COUNT): string[] => {
    if (!Number.isInteger(queue.index) || queue.index < 0 || !(count > 0)) return [];
    const order = queue.shuffle && queue.shuffled.length > 0 ? queue.shuffled : null;
    const ids: string[] = [];
    for (let step = 1; step <= count; step += 1) {
        const position = queue.index + step;
        const queueIndex = order ? order[position] : position;
        if (queueIndex === undefined) break;
        const unique = queue.unique[queueIndex];
        const song = unique === undefined ? undefined : queue.songs[unique];
        if (song?.id && !ids.includes(song.id)) ids.push(song.id);
    }
    return ids;
};
