import merge from 'lodash/merge';
import { nanoid } from 'nanoid';
import { useMemo } from 'react';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { useShallow } from 'zustand/react/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import {
    laneAfterCurrent,
    playbackOrderKeepingLane,
    playLast,
    playNext,
    QueueOrder,
    shuffleAfterLane,
} from '/@/renderer/aoide/features/queue/manual-lane';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import { createSelectors } from '/@/renderer/lib/zustand';
import {
    setTimestamp as setTimestampStore,
    useTimestampStoreBase,
} from '/@/renderer/store/timestamp.store';
import { migratePlayerStorePersist, playerStoreStorage } from '/@/renderer/store/utils';
import { shuffleInPlace } from '/@/renderer/utils/shuffle';
import { PlayerData, QueueData, QueueSong, Song } from '/@/shared/types/domain-types';
import { Play, PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

const SKIP_BACKWARD_SECONDS = 5;
const SKIP_FORWARD_SECONDS = 10;

export interface PlayerState extends Actions, State {}

export type QueueGroupingProperty = keyof QueueSong;

interface Actions {
    addToQueueByType: (items: Song[], playType: Play, playSongId?: string) => void;
    addToQueueByUniqueId: (
        items: Song[],
        uniqueId: string,
        edge: 'bottom' | 'top',
        playSongId?: string,
    ) => void;
    clearQueue: () => void;
    clearSelected: (items: QueueSong[]) => void;
    decreaseVolume: (value: number) => void;
    getCurrentSong: () => QueueSong | undefined;
    getPlayerData: () => PlayerData;
    getQueue: (groupBy?: QueueGroupingProperty) => GroupedQueue;
    getQueueOrder: () => GroupedQueue;
    increaseVolume: (value: number) => void;
    isFirstTrackInQueue: () => boolean;
    isLastTrackInQueue: () => boolean;
    mediaAutoNext: () => PlayerData;
    mediaNext: (toNextAlbum: boolean) => void;
    mediaPause: () => void;
    mediaPlay: (id?: string) => void;
    mediaPlayByIndex: (index: number) => void;
    mediaPrevious: (toPreviousAlbum: boolean) => void;
    mediaSeekToTimestamp: (timestamp: number) => void;
    mediaSkipBackward: (offset?: number) => void;
    mediaSkipForward: (offset?: number) => void;
    /**
     * @param options.reset - When true (default), sets seekToTimestamp(0) so the engine seeks to start.
     * Timestamp display is always cleared to 0. Use false only when the engine has already stopped itself, so it is not asked to seek a track it is no longer holding.
     */
    mediaStop: (options?: { reset?: boolean }) => void;
    mediaToggleMute: () => void;
    mediaTogglePlayPause: () => void;
    moveSelectedTo: (items: QueueSong[], uniqueId: string, edge: 'bottom' | 'top') => void;
    moveSelectedToBottom: (items: QueueSong[]) => void;
    moveSelectedToNext: (items: QueueSong[]) => void;
    moveSelectedToTop: (items: QueueSong[]) => void;
    setPauseOnNextSongEnd: (value: boolean) => void;
    setQueue: (data: Song[], index?: number, position?: number) => void;
    setRepeat: (repeat: PlayerRepeat) => void;
    setShuffle: (shuffle: PlayerShuffle) => void;
    setVolume: (volume: number) => void;
    shuffle: () => void;
    shuffleAll: () => void;
    shuffleSelected: (items: QueueSong[]) => void;
    toggleRepeat: () => void;
    toggleShuffle: () => void;
}

interface GroupedQueue {
    groups: { count: number; name: string }[];
    items: QueueSong[];
}

/**
 * Everything the manual lane needs to read off the store: the two orders, the
 * playhead, and whether a given entry was queued by hand.
 *
 * Written as a structural type rather than `PlayerState` because these run
 * against an immer draft.
 */
type QueueDraft = {
    player: { index: number; shuffle: PlayerShuffle };
    queue: { default: string[]; shuffled: number[]; songs: Record<string, QueueSong> };
};

interface State {
    hydrated: boolean;
    player: {
        index: number;
        muted: boolean;
        pauseOnNextSongEnd: boolean;
        playerNum: 1 | 2;
        repeat: PlayerRepeat;
        seekToTimestamp: string;
        shuffle: PlayerShuffle;
        status: PlayerStatus;
        volume: number;
    };
    queue: QueueData;
}

// Calculates the next song based on repeat mode and current position
export function calculateNextSong(
    currentIndex: number,
    queueItems: QueueSong[],
    repeat: PlayerRepeat,
): QueueSong | undefined {
    if (queueItems.length === 0) {
        return undefined;
    }

    if (repeat === PlayerRepeat.ONE) {
        // When repeating one, next song is the same as current
        return queueItems[currentIndex];
    } else if (repeat === PlayerRepeat.ALL) {
        // When repeating all, next song wraps to first if at the end
        const isLastTrack = currentIndex === queueItems.length - 1;
        if (isLastTrack) {
            return queueItems[0];
        } else {
            return queueItems[currentIndex + 1];
        }
    } else {
        // When repeat is none, next song is undefined if at the end
        return queueItems[currentIndex + 1];
    }
}

export function getDualPlayerSongs(
    playerNum: 1 | 2,
    currentSong: QueueSong | undefined,
    nextSong: QueueSong | undefined,
    repeat: PlayerRepeat,
): { player1: QueueSong | undefined; player2: QueueSong | undefined } {
    if (repeat === PlayerRepeat.ONE) {
        return {
            player1: playerNum === 1 ? currentSong : undefined,
            player2: playerNum === 2 ? currentSong : undefined,
        };
    }

    return {
        player1: playerNum === 1 ? currentSong : nextSong,
        player2: playerNum === 2 ? currentSong : nextSong,
    };
}

// Helper function to check if shuffle is enabled
export function isShuffleEnabled(state: {
    player: { shuffle: PlayerShuffle };
    queue: { shuffled: number[] };
}): boolean {
    return state.player.shuffle === PlayerShuffle.TRACK && state.queue.shuffled.length > 0;
}

// Helper function to map shuffled position to actual queue position
export function mapShuffledToQueueIndex(shuffledIndex: number, shuffled: number[]): number {
    if (shuffledIndex >= 0 && shuffledIndex < shuffled.length) {
        return shuffled[shuffledIndex];
    }
    return shuffledIndex;
}

// Helper function to add new indexes to shuffled array after current position
function addIndexesToShuffled(
    shuffled: number[],
    currentShuffledIndex: number,
    newIndexes: number[],
): number[] {
    // Keep everything before and including current position
    const beforeCurrent = shuffled.slice(0, currentShuffledIndex + 1);
    // Shuffle everything after current position plus new indexes
    const afterCurrent = shuffled.slice(currentShuffledIndex + 1);
    const toShuffle = [...afterCurrent, ...newIndexes];
    return [...beforeCurrent, ...shuffleInPlace(toShuffle)];
}

/** Write both orders back, leaving the permutation alone when shuffle is off. */
function applyQueueOrder(state: QueueDraft, next: QueueOrder): void {
    state.queue.default = next.order;
    if (isShuffleEnabled(state)) {
        state.queue.shuffled = next.shuffled;
    }
}

// Calculates the next index based on repeat mode and current position
function calculateNextIndex(
    currentIndex: number,
    queueLength: number,
    repeat: PlayerRepeat,
): { nextIndex: number; shouldStop: boolean } {
    const isLastTrack = currentIndex === queueLength - 1;

    if (repeat === PlayerRepeat.ONE) {
        // Repeat one: stay on the same track
        return { nextIndex: currentIndex, shouldStop: false };
    } else if (repeat === PlayerRepeat.ALL) {
        // Repeat all: loop to first track if at the end
        if (isLastTrack) {
            return { nextIndex: 0, shouldStop: false };
        } else {
            return { nextIndex: currentIndex + 1, shouldStop: false };
        }
    } else {
        // Repeat none: move to next track, or stop if at the end
        if (isLastTrack) {
            return { nextIndex: currentIndex, shouldStop: true };
        } else {
            return { nextIndex: currentIndex + 1, shouldStop: false };
        }
    }
}

/** The entry playing now, in whichever order playback is following. */
function currentEntryId(state: QueueDraft): string | undefined {
    const position = isShuffleEnabled(state)
        ? mapShuffledToQueueIndex(state.player.index, state.queue.shuffled)
        : state.player.index;
    return state.queue.default[position];
}

function emitPlayerPlayEvent(
    targetSongUniqueId: string | undefined,
    set: (fn: (state: PlayerState) => void) => void,
    get: () => PlayerState,
): void {
    // If playSongId is provided, find the song and start playback on it
    if (targetSongUniqueId) {
        let playIndex: number | undefined;
        set((state) => {
            const queue = state.getQueue();
            const queueIndex = queue.items.findIndex(
                (item) => item._uniqueId === targetSongUniqueId,
            );

            if (queueIndex !== -1) {
                if (
                    state.player.shuffle === PlayerShuffle.TRACK &&
                    state.queue.shuffled.length > 0
                ) {
                    // Find the shuffled position for this queue index
                    const shuffledPosition = state.queue.shuffled.findIndex(
                        (idx) => idx === queueIndex,
                    );
                    if (shuffledPosition !== -1) {
                        state.player.index = shuffledPosition;
                        playIndex = shuffledPosition;
                    } else {
                        state.player.index = queueIndex;
                        playIndex = queueIndex;
                    }
                } else {
                    state.player.index = queueIndex;
                    playIndex = queueIndex;
                }
                state.player.status = PlayerStatus.PLAYING;
                setTimestampStore(0);
            }
        });

        // Emit PLAYER_PLAY event if playback was started
        if (playIndex !== undefined) {
            eventEmitter.emit('PLAYER_PLAY', {
                id: targetSongUniqueId,
                index: playIndex,
            });
        }
    } else {
        // Otherwise, emit PLAYER_PLAY event for current song if available
        const currentState = get();
        const queue = currentState.getQueue();
        const currentIndex = currentState.player.index;
        const currentSong = queue.items[currentIndex];

        if (currentSong && currentIndex !== undefined && currentIndex >= 0) {
            eventEmitter.emit('PLAYER_PLAY', {
                id: currentSong._uniqueId,
                index: currentIndex,
            });
        }
    }
}

function emitPlayerStop(get: () => PlayerState, reset: boolean): void {
    const currentState = get();
    const queue = currentState.getQueue();
    const currentIndex = currentState.player.index;
    const currentSong = queue.items[currentIndex];

    eventEmitter.emit('PLAYER_STOP', {
        id: currentSong?._uniqueId,
        index: currentIndex !== undefined && currentIndex >= 0 ? currentIndex : undefined,
        reset,
    });
}

// Helper function to find shuffled position for a given queue index
function findShuffledPositionForQueueIndex(
    queueIndex: number,
    shuffled: number[],
): number | undefined {
    const shuffledPosition = shuffled.findIndex((idx) => idx === queueIndex);
    return shuffledPosition !== -1 ? shuffledPosition : undefined;
}

// Helper function to generate shuffled indexes for a queue of given length
function generateShuffledIndexes(length: number): number[] {
    const indexes = Array.from({ length }, (_, i) => i);
    return shuffleInPlace(indexes);
}

/**
 * Play Next and Play Last. They differ only in where in the lane they land —
 * the front, or the back of what was already queued by hand and still ahead of
 * the album picking up again.
 */
function insertManualEntries(state: QueueDraft, ids: string[], where: 'last' | 'next'): void {
    const queue = laneQueue(state);
    const next =
        where === 'next'
            ? playNext(queue, ids, state.player.index)
            : playLast(queue, ids, state.player.index, isManualEntry(state));

    applyQueueOrder(state, next);
}

function isManualEntry(state: QueueDraft): (uniqueId: string) => boolean {
    return (uniqueId) => state.queue.songs[uniqueId]?._manual === true;
}

/** The two orders as the lane sees them. Shuffle off means there is no permutation. */
function laneQueue(state: QueueDraft): QueueOrder {
    return {
        order: state.queue.default,
        shuffled: isShuffleEnabled(state) ? state.queue.shuffled : [],
    };
}

/**
 * Rebuild the playback order after the queue itself was rearranged.
 *
 * `currentUniqueId` is read *before* the rearrangement, because the old
 * permutation points at where entries used to be. Keeping the current track
 * first is what makes a re-shuffle a re-shuffle rather than a skip, and it is
 * also the only way the lane can be kept: a lane is defined relative to a
 * playhead.
 */
function regenerateShuffledIndexesIfNeeded(state: QueueDraft, currentUniqueId?: string): void {
    if (state.player.shuffle !== PlayerShuffle.TRACK) return;

    const position = currentUniqueId ? state.queue.default.indexOf(currentUniqueId) : -1;
    state.queue.shuffled = shuffledOrderKeepingLane(state, position);
    if (position >= 0) {
        state.player.index = 0;
    }
}

/** Put a lane read by ``unplayedLane`` back, directly after the new current track. */
function restoreLane(state: QueueDraft, ids: string[], playbackPosition: number): void {
    if (ids.length === 0) return;
    applyQueueOrder(state, playNext(laneQueue(state), ids, playbackPosition));
}

/**
 * A playback order over the whole queue with the current track first and its
 * lane behind it, everything else shuffled.
 *
 * The lane is not shuffled: somebody who queued three songs and then hit
 * shuffle meant "surprise me afterwards", not "scatter the three things I just
 * chose".
 */
function shuffledOrderKeepingLane(state: QueueDraft, currentQueuePosition: number): number[] {
    const indexes = Array.from({ length: state.queue.default.length }, (_, index) => index);
    const isManual = isManualEntry(state);

    return playbackOrderKeepingLane(
        indexes,
        currentQueuePosition,
        (index) => isManual(state.queue.default[index]),
        shuffleInPlace,
    );
}

/**
 * What the listener queued by hand and has not heard yet.
 *
 * Read before a new context replaces the queue: picking a new album is a
 * statement about the album, not a decision to throw away the three songs they
 * lined up a minute ago.
 */
function unplayedLane(state: QueueDraft): string[] {
    return laneAfterCurrent(laneQueue(state), state.player.index, isManualEntry(state));
}

const initialState: State = {
    hydrated: false,
    player: {
        index: -1,
        muted: false,
        pauseOnNextSongEnd: false,
        playerNum: 1,
        repeat: PlayerRepeat.NONE,
        seekToTimestamp: uniqueSeekToTimestamp(0),
        shuffle: PlayerShuffle.NONE,
        status: PlayerStatus.PAUSED,
        volume: 30,
    },
    queue: {
        default: [],
        shuffled: [],
        songs: {},
    },
};

export const usePlayerStoreBase = createWithEqualityFn<PlayerState>()(
    persist(
        subscribeWithSelector(
            immer((set, get) => ({
                addToQueueByType: (items, playType, playSongId) => {
                    // Play Next and Play Last are the listener choosing; Play Now
                    // and Shuffle are a context starting. Only the first two join
                    // the lane.
                    const isManualPlay =
                        playType === Play.LAST ||
                        playType === Play.LAST_SHUFFLE ||
                        playType === Play.NEXT ||
                        playType === Play.NEXT_SHUFFLE;
                    const newItems = items.map((item) => toQueueSong(item, isManualPlay));
                    const newUniqueIds = newItems.map((item) => item._uniqueId);

                    // Find the target song's uniqueId if playSongId is provided
                    const targetSongUniqueId = playSongId
                        ? newItems.find((item) => item.id === playSongId)?._uniqueId
                        : undefined;

                    switch (playType) {
                        case Play.LAST: {
                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                // The back of the lane, not the back of the queue:
                                // asking for a song during a twenty-track album
                                // used to mean hearing it in an hour.
                                insertManualEntries(state, newUniqueIds, 'last');
                            });
                            break;
                        }
                        case Play.LAST_SHUFFLE: {
                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                // Shuffled among themselves, then kept in that
                                // order in both the queue and playback: the lane
                                // shows what it plays.
                                const shuffledIds = shuffleInPlace([...newUniqueIds]);
                                insertManualEntries(state, shuffledIds, 'last');
                            });
                            break;
                        }
                        case Play.NEXT: {
                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                // The front of the lane, ahead of anything queued
                                // earlier.
                                insertManualEntries(state, newUniqueIds, 'next');
                            });
                            break;
                        }
                        case Play.NEXT_SHUFFLE: {
                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                const shuffledIds = shuffleInPlace([...newUniqueIds]);
                                insertManualEntries(state, shuffledIds, 'next');
                            });
                            break;
                        }
                        case Play.NOW: {
                            set((state) => {
                                // Read before the queue goes: what they queued by
                                // hand outlives the thing that was playing.
                                const keptLane = unplayedLane(state);

                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                state.queue.default = [];
                                state.player.index = 0;
                                state.player.status = PlayerStatus.PLAYING;
                                state.player.playerNum = 1;
                                setTimestampStore(0);
                                state.queue.default = newUniqueIds;

                                if (state.player.shuffle === PlayerShuffle.TRACK) {
                                    // If targetSongUniqueId is provided, ensure it's at position 0 in shuffled array
                                    if (targetSongUniqueId) {
                                        const initialIndex = newUniqueIds.findIndex(
                                            (id) => id === targetSongUniqueId,
                                        );
                                        if (initialIndex !== -1) {
                                            const allIndexes = Array.from(
                                                { length: newUniqueIds.length },
                                                (_, i) => i,
                                            );

                                            const remainingIndexes = allIndexes.filter(
                                                (idx) => idx !== initialIndex,
                                            );

                                            const shuffledRemaining = shuffleInPlace([
                                                ...remainingIndexes,
                                            ]);

                                            state.queue.shuffled = [
                                                initialIndex,
                                                ...shuffledRemaining,
                                            ];
                                        } else {
                                            // Fallback: if initial song not found, generate normally
                                            state.queue.shuffled = generateShuffledIndexes(
                                                newUniqueIds.length,
                                            );
                                        }
                                    } else {
                                        state.queue.shuffled = generateShuffledIndexes(
                                            newUniqueIds.length,
                                        );
                                    }
                                }

                                // Back in directly after whatever the new context
                                // starts on. A lane that evaporates the moment
                                // somebody starts something else is a lane nobody
                                // can rely on.
                                const startsOn = targetSongUniqueId
                                    ? Math.max(0, newUniqueIds.indexOf(targetSongUniqueId))
                                    : 0;
                                restoreLane(
                                    state,
                                    keptLane,
                                    isShuffleEnabled(state) ? 0 : startsOn,
                                );
                            });

                            emitPlayerPlayEvent(targetSongUniqueId, set, get);
                            break;
                        }
                        case Play.SHUFFLE: {
                            set((state) => {
                                const keptLane = unplayedLane(state);

                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                // Shuffle the new items before adding to queue
                                const shuffledIds = shuffleInPlace([...newUniqueIds]);

                                state.queue.default = [];
                                state.player.index = 0;
                                state.player.status = PlayerStatus.PLAYING;
                                state.player.playerNum = 1;
                                setTimestampStore(0);
                                state.queue.default = shuffledIds;

                                // Always maintain shuffled array when using Play.SHUFFLE
                                state.queue.shuffled = generateShuffledIndexes(shuffledIds.length);

                                restoreLane(state, keptLane, 0);
                            });

                            emitPlayerPlayEvent(targetSongUniqueId, set, get);
                            break;
                        }
                    }
                },
                addToQueueByUniqueId: (items, uniqueId, edge, playSongId) => {
                    const newItems = items.map((item) => toQueueSong(item));
                    const newUniqueIds = newItems.map((item) => item._uniqueId);

                    // Find the target song's uniqueId if playSongId is provided
                    const targetSongUniqueId = playSongId
                        ? newItems.find((item) => item.id === playSongId)?._uniqueId
                        : undefined;

                    set((state) => {
                        // Add new songs to songs object
                        newItems.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        const index = state.queue.default.findIndex((id) => id === uniqueId);

                        const insertIndex = Math.max(0, edge === 'top' ? index : index + 1);

                        const newQueue = [
                            ...state.queue.default.slice(0, insertIndex),
                            ...newUniqueIds,
                            ...state.queue.default.slice(insertIndex),
                        ];

                        state.queue.default = newQueue;

                        if (state.player.shuffle === PlayerShuffle.TRACK) {
                            const currentTrack = state.getCurrentSong() as QueueSong | undefined;
                            const currentTrackUniqueId = currentTrack?._uniqueId;

                            if (currentTrackUniqueId) {
                                // Adjust existing shuffled indexes that are >= insertIndex
                                const adjustedShuffled = state.queue.shuffled.map((idx) => {
                                    if (idx >= insertIndex) {
                                        return idx + newUniqueIds.length;
                                    }
                                    return idx;
                                });

                                // New items will be at indexes starting from insertIndex
                                const newIndexes = Array.from(
                                    { length: newUniqueIds.length },
                                    (_, i) => insertIndex + i,
                                );

                                const currentShuffledIndex = state.player.index;
                                state.queue.shuffled = addIndexesToShuffled(
                                    adjustedShuffled,
                                    currentShuffledIndex,
                                    newIndexes,
                                );

                                // Recalculate player index to the shuffled position
                                const queueIndex = newQueue.findIndex(
                                    (id) => id === currentTrackUniqueId,
                                );
                                if (queueIndex !== -1) {
                                    const shuffledPosition = state.queue.shuffled.findIndex(
                                        (idx) => idx === queueIndex,
                                    );
                                    if (shuffledPosition !== -1) {
                                        state.player.index = shuffledPosition;
                                    }
                                }
                            } else {
                                // No current track, regenerate shuffled indexes
                                state.queue.shuffled = generateShuffledIndexes(newQueue.length);
                            }
                        } else {
                            // Recalculate the player index if we're inserting items above the current index
                            if (insertIndex <= state.player.index) {
                                state.player.index = state.player.index + newUniqueIds.length;
                            }

                            recalculatePlayerIndex(state, newQueue);
                        }
                    });

                    // If playSongId is provided, find the song and start playback on it
                    if (targetSongUniqueId) {
                        let playIndex: number | undefined;
                        set((state) => {
                            const queue = state.getQueue();
                            const queueIndex = queue.items.findIndex(
                                (item) => item._uniqueId === targetSongUniqueId,
                            );

                            if (queueIndex !== -1) {
                                if (
                                    state.player.shuffle === PlayerShuffle.TRACK &&
                                    state.queue.shuffled.length > 0
                                ) {
                                    // Find the shuffled position for this queue index
                                    const shuffledPosition = state.queue.shuffled.findIndex(
                                        (idx) => idx === queueIndex,
                                    );
                                    if (shuffledPosition !== -1) {
                                        state.player.index = shuffledPosition;
                                        playIndex = shuffledPosition;
                                    } else {
                                        state.player.index = queueIndex;
                                        playIndex = queueIndex;
                                    }
                                } else {
                                    state.player.index = queueIndex;
                                    playIndex = queueIndex;
                                }
                                state.player.status = PlayerStatus.PLAYING;
                                setTimestampStore(0);
                            }
                        });

                        // Emit PLAYER_PLAY event if playback was started
                        if (playIndex !== undefined) {
                            eventEmitter.emit('PLAYER_PLAY', {
                                id: targetSongUniqueId,
                                index: playIndex,
                            });
                        }
                    }
                },
                clearQueue: () => {
                    set((state) => {
                        state.player.index = -1;
                        state.queue.default = [];
                        state.queue.shuffled = [];
                        state.queue.songs = {};
                    });
                },
                clearSelected: (items: QueueSong[]) => {
                    set((state) => {
                        const uniqueIds = new Set(items.map((item) => item._uniqueId));

                        const indexesToRemove = new Set<number>();

                        state.queue.default.forEach((id, index) => {
                            if (uniqueIds.has(id)) {
                                indexesToRemove.add(index);
                            }
                        });

                        state.queue.default = state.queue.default.filter(
                            (id) => !uniqueIds.has(id),
                        );

                        if (isShuffleEnabled(state)) {
                            // Remove indexes from shuffled array and adjust remaining indexes
                            const newShuffled = state.queue.shuffled
                                .filter((idx) => !indexesToRemove.has(idx))
                                .map((idx) => {
                                    // Count how many removed indexes are before this index
                                    let adjustment = 0;
                                    for (const removedIdx of indexesToRemove) {
                                        if (removedIdx < idx) {
                                            adjustment++;
                                        }
                                    }
                                    return idx - adjustment;
                                });
                            state.queue.shuffled = newShuffled;
                        } else {
                            state.queue.shuffled = [];
                        }

                        cleanupOrphanedSongs(state);

                        recalculatePlayerIndex(state, state.queue.default);
                    });
                },
                decreaseVolume: (value: number) => {
                    set((state) => {
                        state.player.volume = Math.max(0, state.player.volume - value);
                    });
                },
                getCurrentSong: () => {
                    const state = get();
                    const queue = state.getQueue();
                    let index = state.player.index;

                    // If shuffle is enabled, map shuffled position to actual queue position
                    if (isShuffleEnabled(state)) {
                        index = mapShuffledToQueueIndex(index, state.queue.shuffled);
                    }

                    return queue.items[index];
                },
                getPlayerData: () => {
                    const state = get();
                    const queue = state.getQueue();
                    const index = state.player.index;

                    // If shuffle is enabled, map shuffled position to actual queue position for display
                    let queueIndex = index;
                    if (isShuffleEnabled(state)) {
                        queueIndex = mapShuffledToQueueIndex(index, state.queue.shuffled);
                    }

                    const currentSong = queue.items[queueIndex];
                    const repeat = state.player.repeat;

                    // For previousSong calculation, we need to consider the shuffled order
                    let previousSong: QueueSong | undefined;
                    if (isShuffleEnabled(state)) {
                        // Calculate previous in shuffled order
                        const previousShuffledIndex = index - 1;
                        if (previousShuffledIndex >= 0) {
                            const previousQueueIndex = state.queue.shuffled[previousShuffledIndex];
                            previousSong = queue.items[previousQueueIndex];
                        } else if (repeat === PlayerRepeat.ALL) {
                            // Wrap to last in shuffled order
                            const lastShuffledIndex = state.queue.shuffled.length - 1;
                            const lastQueueIndex = state.queue.shuffled[lastShuffledIndex];
                            previousSong = queue.items[lastQueueIndex];
                        }
                    } else {
                        previousSong = queueIndex > 0 ? queue.items[queueIndex - 1] : undefined;
                    }

                    // For nextSong calculation, we need to consider the shuffled order
                    let nextSong: QueueSong | undefined;
                    if (isShuffleEnabled(state) && repeat !== PlayerRepeat.ONE) {
                        // Calculate next in shuffled order
                        const nextShuffledIndex = index + 1;
                        if (nextShuffledIndex < state.queue.shuffled.length) {
                            const nextQueueIndex = state.queue.shuffled[nextShuffledIndex];
                            nextSong = queue.items[nextQueueIndex];
                        } else if (repeat === PlayerRepeat.ALL) {
                            // Wrap to first in shuffled order
                            const firstQueueIndex = state.queue.shuffled[0];
                            nextSong = queue.items[firstQueueIndex];
                        }
                    } else {
                        nextSong = calculateNextSong(queueIndex, queue.items, repeat);
                    }

                    const { player1, player2 } = getDualPlayerSongs(
                        state.player.playerNum,
                        currentSong,
                        nextSong,
                        repeat,
                    );

                    return {
                        currentSong,
                        index: queueIndex, // Return the actual queue position for display
                        nextSong,
                        num: state.player.playerNum,
                        player1,
                        player2,
                        previousSong,
                        queueLength: state.queue.default.length,
                        status: state.player.status,
                    };
                },
                getQueue: (groupBy?: QueueGroupingProperty) => {
                    const queue = get().getQueueOrder();

                    if (!groupBy) {
                        return queue;
                    }

                    // Track groups in order of appearance
                    const groups: { count: number; name: string }[] = [];
                    const seenGroups = new Set<string>();

                    // Process items and build groups in order
                    queue.items.forEach((item) => {
                        const groupValue = String(item[groupBy] || 'Unknown');

                        if (!seenGroups.has(groupValue)) {
                            seenGroups.add(groupValue);
                            groups.push({ count: 1, name: groupValue });
                        } else {
                            // Find the last occurrence of this group value
                            const lastIndex = [...groups]
                                .reverse()
                                .findIndex((g) => g.name === groupValue);
                            if (lastIndex === -1) return;

                            // If the previous group is different, create a new group
                            const previousGroup = groups[groups.length - 1];
                            if (previousGroup.name !== groupValue) {
                                groups.push({ count: 1, name: groupValue });
                            } else {
                                // Increment the count of the last matching group
                                groups[groups.length - 1].count++;
                            }
                        }
                    });

                    return { groups, items: queue.items };
                },
                getQueueOrder: () => {
                    const state = get();
                    const songs = state.queue.songs;
                    const defaultIds = state.queue.default;
                    const defaultQueue: QueueSong[] = [];

                    for (const id of defaultIds) {
                        const song = songs[id];
                        if (song) defaultQueue.push(song);
                    }

                    // Always return original order (shuffle only affects playback, not display)
                    return {
                        groups: [{ count: defaultQueue.length, name: 'All' }],
                        items: defaultQueue,
                    };
                },
                increaseVolume: (value: number) => {
                    set((state) => {
                        state.player.volume = Math.min(100, state.player.volume + value);
                    });
                },
                isFirstTrackInQueue: () => {
                    const state = get();
                    const currentIndex = state.player.index;
                    return currentIndex === 0;
                },
                isLastTrackInQueue: () => {
                    const state = get();
                    const queue = state.getQueueOrder();
                    const currentIndex = state.player.index;
                    return currentIndex === queue.items.length - 1;
                },
                mediaAutoNext: () => {
                    const stateSnapshot = get();
                    const currentIndex = stateSnapshot.player.index;
                    const player = stateSnapshot.player;
                    const repeat = player.repeat;
                    const queue = stateSnapshot.getQueueOrder();
                    const isShuffle = isShuffleEnabled(stateSnapshot);

                    const playbackLength = isShuffle
                        ? stateSnapshot.queue.shuffled.length
                        : queue.items.length;

                    const { nextIndex: nextPlaybackIndex, shouldStop } = calculateNextIndex(
                        currentIndex,
                        playbackLength,
                        repeat,
                    );

                    const isRepeatOneSameTrack =
                        repeat === PlayerRepeat.ONE && nextPlaybackIndex === currentIndex;
                    // Dual web players alternate for gapless/crossfade between tracks. Repeat-one
                    // replays the same track — keep playerNum so Chromium stays bound to the same
                    // <audio> element and hardware media keys keep working.
                    const newPlayerNum = isRepeatOneSameTrack
                        ? player.playerNum
                        : player.playerNum === 1
                          ? 2
                          : 1;
                    const pauseOnNext = player.pauseOnNextSongEnd;
                    const newStatus = shouldStop
                        ? PlayerStatus.STOPPED
                        : pauseOnNext
                          ? PlayerStatus.PAUSED
                          : PlayerStatus.PLAYING;
                    const shouldKeepCurrentPlayer = newStatus !== PlayerStatus.PLAYING;
                    const shouldSwapPlayer = !isRepeatOneSameTrack && !shouldKeepCurrentPlayer;

                    set((state) => {
                        state.player.index = nextPlaybackIndex;
                        state.player.playerNum = shouldSwapPlayer ? newPlayerNum : player.playerNum;
                        setTimestampStore(0);
                        state.player.status = newStatus;

                        if (shouldStop) {
                            state.player.seekToTimestamp = uniqueSeekToTimestamp(0);
                        }

                        if (pauseOnNext) {
                            state.player.pauseOnNextSongEnd = false;
                        }
                    });

                    if (shouldStop) {
                        emitPlayerStop(get, true);
                    }

                    if (repeat === PlayerRepeat.ONE && nextPlaybackIndex === currentIndex) {
                        eventEmitter.emit('PLAYER_REPEATED', {
                            index: nextPlaybackIndex,
                        });
                    }

                    // Compute current/next/previous using the same shuffle-aware mapping as getPlayerData().
                    let currentQueueIndex = nextPlaybackIndex;
                    if (isShuffle) {
                        currentQueueIndex = mapShuffledToQueueIndex(
                            nextPlaybackIndex,
                            stateSnapshot.queue.shuffled,
                        );
                    }

                    const currentSong = queue.items[currentQueueIndex];

                    let nextSong: QueueSong | undefined;
                    if (isShuffle && repeat !== PlayerRepeat.ONE) {
                        const nextShuffledIndex = nextPlaybackIndex + 1;
                        if (nextShuffledIndex < stateSnapshot.queue.shuffled.length) {
                            const nextQueueIndex = stateSnapshot.queue.shuffled[nextShuffledIndex];
                            nextSong = queue.items[nextQueueIndex];
                        } else if (repeat === PlayerRepeat.ALL) {
                            const firstQueueIndex = stateSnapshot.queue.shuffled[0];
                            nextSong = queue.items[firstQueueIndex];
                        }
                    } else {
                        nextSong = calculateNextSong(currentQueueIndex, queue.items, repeat);
                    }

                    let previousSong: QueueSong | undefined;
                    if (isShuffle) {
                        const prevShuffledIndex = nextPlaybackIndex - 1;
                        if (prevShuffledIndex >= 0) {
                            const prevQueueIndex = stateSnapshot.queue.shuffled[prevShuffledIndex];
                            previousSong = queue.items[prevQueueIndex];
                        } else if (repeat === PlayerRepeat.ALL) {
                            const lastShuffledIndex = stateSnapshot.queue.shuffled.length - 1;
                            const lastQueueIndex = stateSnapshot.queue.shuffled[lastShuffledIndex];
                            previousSong = queue.items[lastQueueIndex];
                        }
                    } else {
                        previousSong =
                            currentQueueIndex > 0 ? queue.items[currentQueueIndex - 1] : undefined;
                    }

                    const { player1, player2 } = getDualPlayerSongs(
                        shouldSwapPlayer ? newPlayerNum : player.playerNum,
                        currentSong,
                        nextSong,
                        repeat,
                    );

                    return {
                        currentSong,
                        index: currentQueueIndex,
                        nextSong,
                        num: shouldSwapPlayer ? newPlayerNum : player.playerNum,
                        player1,
                        player2,
                        previousSong,
                        queueLength: queue.items.length,
                        status: newStatus,
                    };
                },
                mediaNext: (toNextAlbum) => {
                    const state = get();
                    const currentIndex = state.player.index;
                    const player = state.player;
                    const repeat = player.repeat;
                    const isShuffle = isShuffleEnabled(state);
                    const queue = state.getQueueOrder();
                    const playbackLength = isShuffle
                        ? state.queue.shuffled.length
                        : queue.items.length;

                    const isStopped = state.player.status === PlayerStatus.STOPPED;

                    if (repeat === PlayerRepeat.ONE) {
                        // Manual next while repeat-one is active should still advance in the queue.
                        const nextIndex = Math.min(playbackLength - 1, currentIndex + 1);

                        set((state) => {
                            state.player.index = nextIndex;
                            state.player.playerNum = 1;
                            setTimestampStore(0);

                            if (isStopped) {
                                state.player.status = PlayerStatus.PLAYING;
                            }
                        });

                        eventEmitter.emit('MEDIA_NEXT', {
                            currentIndex,
                            nextIndex,
                        });
                        return;
                    }

                    const nextIndexProps = calculateNextIndex(currentIndex, playbackLength, repeat);
                    let { nextIndex } = nextIndexProps;
                    const { shouldStop } = nextIndexProps;

                    if (toNextAlbum && !shouldStop) {
                        const currentItem = queue.items[currentIndex];
                        const [start, end] = findLastAlbumRange(queue.items);
                        const isOnLastAlbum = start <= currentIndex && currentIndex <= end;
                        if (isOnLastAlbum) {
                            const nextIndexWithNextAlbum = queue.items.findIndex(
                                (i) => i.albumId !== currentItem.albumId,
                            );

                            nextIndex = nextIndexWithNextAlbum;
                        } else {
                            const queueStartingFromCurrent = queue.items.slice(currentIndex);
                            const nextIndexWithNextAlbum = queueStartingFromCurrent.findIndex(
                                (i) => i.albumId !== currentItem.albumId,
                            );
                            nextIndex =
                                nextIndexWithNextAlbum +
                                (queue.items.length - queueStartingFromCurrent.length);
                        }
                    }

                    if (shouldStop) {
                        set((state) => {
                            state.player.status = PlayerStatus.STOPPED;
                            state.player.playerNum = 1;
                            setTimestampStore(0);
                            state.player.seekToTimestamp = uniqueSeekToTimestamp(0);
                        });
                        emitPlayerStop(get, true);
                        return;
                    }

                    set((state) => {
                        state.player.index = nextIndex;
                        state.player.playerNum = 1;
                        setTimestampStore(0);

                        if (isStopped) {
                            state.player.status = PlayerStatus.PLAYING;
                        }
                    });

                    eventEmitter.emit('MEDIA_NEXT', {
                        currentIndex,
                        nextIndex,
                    });
                },
                mediaPause: () => {
                    set((state) => {
                        state.player.status = PlayerStatus.PAUSED;
                    });
                },
                mediaPlay: (id?: string) => {
                    let playIndex: number | undefined;

                    set((state) => {
                        if (id) {
                            const queue = state.getQueue();

                            // Find the song in the original queue
                            const queueIndex = queue.items.findIndex(
                                (item) => item._uniqueId === id,
                            );

                            if (queueIndex !== -1) {
                                if (
                                    state.player.shuffle === PlayerShuffle.TRACK &&
                                    state.queue.shuffled.length > 0
                                ) {
                                    // Find the shuffled position for this queue index
                                    const shuffledPosition = state.queue.shuffled.findIndex(
                                        (idx) => idx === queueIndex,
                                    );
                                    if (shuffledPosition !== -1) {
                                        state.player.index = shuffledPosition;
                                        playIndex = shuffledPosition;
                                    } else {
                                        state.player.index = queueIndex;
                                        playIndex = queueIndex;
                                    }
                                } else {
                                    state.player.index = queueIndex;
                                    playIndex = queueIndex;
                                }
                                setTimestampStore(0);
                            }
                        }

                        state.player.status = PlayerStatus.PLAYING;
                    });

                    if (id && playIndex !== undefined) {
                        eventEmitter.emit('PLAYER_PLAY', {
                            id,
                            index: playIndex,
                        });
                    }
                },
                mediaPlayByIndex: (index: number) => {
                    let playIndex: number | undefined;
                    let songId: string | undefined;

                    set((state) => {
                        const queue = state.getQueue();

                        if (index === -1 || index >= queue.items.length) {
                            state.player.status = PlayerStatus.PAUSED;
                            return;
                        }

                        // Get the song's unique ID from the queue
                        const song = queue.items[index];
                        if (song) {
                            songId = song._uniqueId;
                        }

                        // index is the position in the original queue
                        if (isShuffleEnabled(state)) {
                            // Find the shuffled position for this queue index
                            const shuffledPosition = findShuffledPositionForQueueIndex(
                                index,
                                state.queue.shuffled,
                            );
                            playIndex = shuffledPosition !== undefined ? shuffledPosition : index;
                            state.player.index = playIndex;
                        } else {
                            playIndex = index;
                            state.player.index = index;
                        }
                        setTimestampStore(0);

                        state.player.status = PlayerStatus.PLAYING;
                    });

                    if (songId && playIndex !== undefined) {
                        eventEmitter.emit('PLAYER_PLAY', {
                            id: songId,
                            index: playIndex,
                        });
                    }
                },
                mediaPrevious: (toPreviousAlbum) => {
                    const currentIndex = get().player.index;
                    const player = get().player;
                    const queue = get().getQueueOrder();
                    const currentTimestamp = useTimestampStoreBase.getState().timestamp;
                    const isFirstTrack = currentIndex === 0;

                    // If timestamp is greater than 10 seconds, restart current song
                    if (currentTimestamp > 10) {
                        set((state) => {
                            state.player.seekToTimestamp = uniqueSeekToTimestamp(0);
                        });
                        return;
                    }

                    let previousIndex: number;

                    if (player.repeat === PlayerRepeat.ALL && isFirstTrack) {
                        // Repeat all: wrap to last track when on first track
                        previousIndex = queue.items.length - 1;
                    } else if (player.repeat === PlayerRepeat.NONE && isFirstTrack) {
                        // Repeat none: stay on first track if already there
                        previousIndex = currentIndex;
                    } else if (toPreviousAlbum) {
                        previousIndex = Math.max(
                            0,
                            findIndexWithPreviousAlbum(queue.items, currentIndex),
                        );
                    } else {
                        // Otherwise, go to previous track
                        previousIndex = Math.max(0, currentIndex - 1);
                    }

                    // Same Chromium Media Session pitfall as mediaNext: a STOPPED→new-src
                    // transition without PLAYING drops OS media-key routing.
                    const resumeFromStopped = get().player.status === PlayerStatus.STOPPED;

                    set((state) => {
                        state.player.index = previousIndex;
                        state.player.playerNum = 1;
                        setTimestampStore(0);
                        if (resumeFromStopped) {
                            state.player.status = PlayerStatus.PLAYING;
                        }
                    });

                    eventEmitter.emit('MEDIA_PREV', {
                        currentIndex,
                        prevIndex: previousIndex,
                    });
                },
                mediaSeekToTimestamp: (timestamp: number) => {
                    // See mediaSkipBackward: update the timestamp store right away to
                    // avoid the stale-read left by the ~500ms engine poll.
                    setTimestampStore(timestamp);
                    set((state) => {
                        state.player.seekToTimestamp = uniqueSeekToTimestamp(timestamp);
                    });
                },
                mediaSkipBackward: (offset?: number) => {
                    const timeToSkip = offset ?? SKIP_BACKWARD_SECONDS;
                    const currentTimestamp = useTimestampStoreBase.getState().timestamp;
                    const newTimestamp = Math.max(0, currentTimestamp - timeToSkip);

                    // Update the timestamp store right away so the UI and any
                    // subsequent seek compute from the new position instead of the
                    // stale value left by the ~500ms engine poll (otherwise mashing
                    // the seek keys repeatedly lands on the same time).
                    setTimestampStore(newTimestamp);
                    set((state) => {
                        state.player.seekToTimestamp = uniqueSeekToTimestamp(newTimestamp);
                    });
                },
                mediaSkipForward: (offset?: number) => {
                    const state = get();
                    const queue = state.getQueue();
                    const index = state.player.index;
                    const currentTrack = queue.items[index];
                    const duration = currentTrack?.duration;
                    const timeToSkip = offset ?? SKIP_FORWARD_SECONDS;

                    if (!duration) {
                        return;
                    }

                    const currentTimestamp = useTimestampStoreBase.getState().timestamp;
                    const newTimestamp = Math.min(duration - 1, currentTimestamp + timeToSkip);

                    // See mediaSkipBackward: update the timestamp store right away to
                    // avoid the stale-read left by the ~500ms engine poll.
                    setTimestampStore(newTimestamp);
                    set((state) => {
                        state.player.seekToTimestamp = uniqueSeekToTimestamp(newTimestamp);
                    });
                },
                mediaStop: (options?: { reset?: boolean }) => {
                    const reset = options?.reset !== false;
                    set((state) => {
                        state.player.status = PlayerStatus.STOPPED;
                        setTimestampStore(0);
                        if (reset) {
                            state.player.seekToTimestamp = uniqueSeekToTimestamp(0);
                        }
                    });

                    emitPlayerStop(get, reset);
                },
                mediaToggleMute: () => {
                    set((state) => {
                        state.player.muted = !state.player.muted;
                    });
                },
                mediaTogglePlayPause: () => {
                    // Restarting from STOPPED (e.g. end of queue) needs a full play
                    // event so the engine reloads the current track; a bare play()
                    // is a no-op once the engine has let go of it.
                    const wasStopped = get().player.status === PlayerStatus.STOPPED;

                    set((state) => {
                        if (state.player.status === PlayerStatus.PLAYING) {
                            state.player.status = PlayerStatus.PAUSED;
                        } else {
                            state.player.status = PlayerStatus.PLAYING;
                        }
                    });

                    if (wasStopped) {
                        emitPlayerPlayEvent(undefined, set, get);
                    }
                },
                moveSelectedTo: (items: QueueSong[], uniqueId: string, edge: 'bottom' | 'top') => {
                    const itemUniqueIds = items.map((item) => item._uniqueId);

                    set((state) => {
                        const existingIds = new Set(Object.keys(state.queue.songs));

                        // Add new songs to songs object (avoiding duplicates)
                        items.forEach((item) => {
                            if (!existingIds.has(item._uniqueId)) {
                                state.queue.songs[item._uniqueId] = item;
                            }
                        });

                        // Find the index of the drop target
                        const index = state.queue.default.findIndex((id) => id === uniqueId);

                        // Get the new index based on the edge
                        const insertIndex = Math.max(0, edge === 'top' ? index : index + 1);

                        const idsBefore = state.queue.default
                            .slice(0, insertIndex)
                            .filter((id) => !itemUniqueIds.includes(id));

                        const idsAfter = state.queue.default
                            .slice(insertIndex)
                            .filter((id) => !itemUniqueIds.includes(id));

                        const newQueue = [...idsBefore, ...itemUniqueIds, ...idsAfter];

                        recalculatePlayerIndex(state, newQueue);
                        state.queue.default = newQueue;
                    });
                },
                moveSelectedToBottom: (items: QueueSong[]) => {
                    set((state) => {
                        const uniqueIds = items.map((item) => item._uniqueId);

                        // Add new songs to songs object
                        items.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        const filtered = state.queue.default.filter(
                            (id) => !uniqueIds.includes(id),
                        );

                        const newQueue = [...filtered, ...uniqueIds];

                        recalculatePlayerIndex(state, newQueue);

                        state.queue.default = newQueue;
                    });
                },
                moveSelectedToNext: (items: QueueSong[]) => {
                    set((state) => {
                        const uniqueIds = items.map((item) => item._uniqueId);

                        // Add new songs to songs object
                        items.forEach((item) => {
                            // Moving something to play next is the listener
                            // choosing it, so it joins the lane rather than
                            // splitting it in two.
                            state.queue.songs[item._uniqueId] = { ...item, _manual: true };
                        });

                        const currentIndex = state.player.index;
                        let beforeCurrent = 0;
                        const filtered = state.queue.default.filter((id, idx) => {
                            const shouldMove = uniqueIds.includes(id);
                            if (shouldMove && idx < currentIndex) {
                                beforeCurrent++;
                            }

                            return !shouldMove;
                        });

                        // For every item that is before the current item, subtract one as
                        // these items will shift the queue up
                        const insertIndex = currentIndex + 1 - beforeCurrent;

                        const newQueue = [
                            ...filtered.slice(0, insertIndex),
                            ...uniqueIds,
                            ...filtered.slice(insertIndex),
                        ];

                        recalculatePlayerIndex(state, newQueue);
                        state.queue.default = newQueue;
                    });
                },
                moveSelectedToTop: (items: QueueSong[]) => {
                    set((state) => {
                        const uniqueIds = items.map((item) => item._uniqueId);

                        // Add new songs to songs object
                        items.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        const filtered = state.queue.default.filter(
                            (id) => !uniqueIds.includes(id),
                        );

                        const newQueue = [...uniqueIds, ...filtered];

                        recalculatePlayerIndex(state, newQueue);

                        state.queue.default = newQueue;
                    });
                },
                setQueue: (items, index, position) => {
                    const newItems = items.map((item) => toQueueSong(item));
                    const newUniqueIds = newItems.map((item) => item._uniqueId);

                    set((state) => {
                        newItems.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        state.player.index = index ?? 0;
                        state.player.status = PlayerStatus.PLAYING;
                        state.player.playerNum = 1;
                        state.queue.default = newUniqueIds;
                    });

                    eventEmitter.emit('QUEUE_RESTORED', {
                        data: items,
                        index: index ?? 0,
                        position: position ?? 0,
                    });
                },
                ...initialState,
                setPauseOnNextSongEnd: (value: boolean) => {
                    set((state) => {
                        state.player.pauseOnNextSongEnd = value;
                    });
                },
                setRepeat: (repeat: PlayerRepeat) => {
                    set((state) => {
                        state.player.repeat = repeat;
                    });
                },
                setShuffle: (shuffle: PlayerShuffle) => {
                    set((state) => {
                        const wasShuffled = state.player.shuffle === PlayerShuffle.TRACK;
                        const willBeShuffled = shuffle === PlayerShuffle.TRACK;
                        const currentIndex = state.player.index;

                        state.player.shuffle = shuffle;

                        if (willBeShuffled) {
                            // The same order `toggleShuffle` builds, for the same
                            // reason: the song playing keeps playing and the lane
                            // stays in front of the shuffle.
                            const hasCurrent =
                                currentIndex >= 0 && currentIndex < state.queue.default.length;

                            state.queue.shuffled = shuffledOrderKeepingLane(
                                state,
                                hasCurrent ? currentIndex : -1,
                            );

                            if (hasCurrent) {
                                state.player.index = 0;
                            }
                        } else {
                            // When disabling shuffle, convert shuffled position back to queue position
                            if (
                                wasShuffled &&
                                currentIndex >= 0 &&
                                currentIndex < state.queue.shuffled.length
                            ) {
                                const queuePosition = state.queue.shuffled[currentIndex];
                                if (queuePosition !== undefined) {
                                    state.player.index = queuePosition;
                                }
                            }
                            state.queue.shuffled = [];
                        }
                        cleanupOrphanedSongs(state);
                    });
                },
                setVolume: (volume: number) => {
                    set((state) => {
                        state.player.volume = volume;
                    });
                },
                shuffle: () => {
                    set((state) => {
                        // A re-shuffle: the track playing keeps playing, its lane
                        // stays in front of the shuffle, and the rest is re-rolled.
                        regenerateShuffledIndexesIfNeeded(state, currentEntryId(state));
                    });
                },
                shuffleAll: () => {
                    set((state) => {
                        const queue = state.getQueue();
                        const currentIndex = state.player.index;
                        const currentSong = queue.items[currentIndex];

                        // If there's a current song playing, keep it in place
                        if (currentSong && currentIndex >= 0 && currentIndex < queue.items.length) {
                            const currentUniqueId = currentSong._uniqueId;
                            const currentQueueIndex = state.queue.default.findIndex(
                                (id) => id === currentUniqueId,
                            );

                            if (currentQueueIndex !== -1) {
                                const beforeItems = state.queue.default.slice(0, currentQueueIndex);
                                const fromCurrent = state.queue.default.slice(currentQueueIndex);

                                const shuffledBefore = shuffleInPlace([...beforeItems]);

                                state.queue.default = [
                                    ...shuffledBefore,
                                    // The current track and its lane stay put; only
                                    // what comes after them is shuffled.
                                    ...shuffleAfterLane(
                                        [...fromCurrent],
                                        0,
                                        isManualEntry(state),
                                        shuffleInPlace,
                                    ),
                                ];

                                regenerateShuffledIndexesIfNeeded(state, currentUniqueId);
                                return;
                            }

                            // Current song not in default queue, just shuffle everything
                            state.queue.default = shuffleInPlace([...state.queue.default]);
                        } else {
                            // No current song, shuffle everything
                            state.queue.default = shuffleInPlace([...state.queue.default]);
                        }

                        // Regenerate shuffled indexes if shuffle is enabled
                        regenerateShuffledIndexesIfNeeded(state);
                    });
                },
                shuffleSelected: (items: QueueSong[]) => {
                    set((state) => {
                        // Read before the rearrangement: the old permutation
                        // points at where entries used to be.
                        const playing = currentEntryId(state);
                        const itemUniqueIds = items.map((item) => item._uniqueId);

                        // Find positions of selected items in the default queue
                        const selectedPositions = itemUniqueIds
                            .map((id) => state.queue.default.findIndex((i) => i === id))
                            .filter((idx) => idx !== -1)
                            .sort((a, b) => a - b); // Sort to maintain order

                        if (selectedPositions.length === 0) {
                            return;
                        }

                        // Get the selected items in their current order
                        const selectedItems = selectedPositions.map(
                            (pos) => state.queue.default[pos],
                        );

                        // Shuffle the selected items
                        const shuffledItems = shuffleInPlace([...selectedItems]);

                        // Rebuild the default queue with shuffled selected items
                        const newDefaultQueue = [...state.queue.default];
                        selectedPositions.forEach((pos, i) => {
                            newDefaultQueue[pos] = shuffledItems[i];
                        });

                        state.queue.default = newDefaultQueue;

                        // Regenerate shuffled indexes if shuffle is enabled
                        regenerateShuffledIndexesIfNeeded(state, playing);
                    });
                },
                toggleRepeat: () => {
                    set((state) => {
                        if (state.player.repeat === PlayerRepeat.NONE) {
                            state.player.repeat = PlayerRepeat.ONE;
                        } else if (state.player.repeat === PlayerRepeat.ONE) {
                            state.player.repeat = PlayerRepeat.ALL;
                        } else {
                            state.player.repeat = PlayerRepeat.NONE;
                        }
                    });
                },
                toggleShuffle: () => {
                    set((state) => {
                        const wasShuffled = state.player.shuffle === PlayerShuffle.TRACK;
                        const willBeShuffled = state.player.shuffle !== PlayerShuffle.TRACK;
                        const currentIndex = state.player.index;

                        state.player.shuffle =
                            state.player.shuffle === PlayerShuffle.NONE
                                ? PlayerShuffle.TRACK
                                : PlayerShuffle.NONE;

                        if (willBeShuffled) {
                            // Enabling shuffle: create shuffled indexes with current track as first
                            const combinedLength = state.queue.default.length;

                            if (
                                combinedLength > 0 &&
                                currentIndex >= 0 &&
                                currentIndex < combinedLength
                            ) {
                                // Current track first, then the lane, then the
                                // rest at random.
                                state.queue.shuffled = shuffledOrderKeepingLane(
                                    state,
                                    currentIndex,
                                );

                                // Set player index to 0 since current track is now first in shuffled array
                                state.player.index = 0;
                            } else {
                                // No current track, just generate shuffled indexes normally
                                state.queue.shuffled = generateShuffledIndexes(combinedLength);
                            }
                        } else {
                            // Disabling shuffle: clear shuffled indexes and convert index back
                            if (
                                wasShuffled &&
                                currentIndex >= 0 &&
                                currentIndex < state.queue.shuffled.length
                            ) {
                                const queuePosition = state.queue.shuffled[currentIndex];
                                if (queuePosition !== undefined) {
                                    state.player.index = queuePosition;
                                }
                            }
                            state.queue.shuffled = [];
                        }
                    });
                },
            })),
        ),
        {
            merge: (persistedState: any, currentState: any) => {
                return merge(currentState, persistedState);
            },
            migrate: async (persistedState, oldVersion) => {
                if (oldVersion < 3) {
                    return {} as PlayerState;
                }

                if (oldVersion === 3) {
                    await migratePlayerStorePersist('player-store');
                }

                if (oldVersion < 5) {
                    // Feishin's own crossfade went. Equal power is the only
                    // curve worth having, Crossfade already forces it, and the
                    // three keys are deleted rather than left in the persisted
                    // player so a settings export does not hand them on.
                    const player = (persistedState as Partial<PlayerState>)?.player as
                        | (Partial<PlayerState>['player'] & {
                              crossfadeDuration?: number;
                              crossfadeStyle?: string;
                              transitionType?: string;
                          })
                        | undefined;

                    if (player) {
                        delete player.crossfadeDuration;
                        delete player.crossfadeStyle;
                        delete player.transitionType;
                    }
                }

                return persistedState as Partial<PlayerState>;
            },
            name: 'player-store',
            onRehydrateStorage: () => () => {
                usePlayerStoreBase.setState({ hydrated: true });
            },
            partialize: (state) => {
                // Exclude playerNum, seekToTimestamp, and status from stored player object
                // These are not needed to be stored since they are ephemeral properties
                // Note: timestamp is now in a separate store and doesn't need to be excluded here
                const excludedPlayerKeys = ['playerNum', 'seekToTimestamp', 'status'];

                const player = Object.fromEntries(
                    Object.entries(state.player).filter(
                        ([key]) => !excludedPlayerKeys.includes(key),
                    ),
                ) as typeof state.player;

                // Queue pruning and IDB writes are handled in `playerStoreStorage` so we only
                // serialize the large queue when the queue slice reference actually changes.
                return { player, queue: state.queue };
            },
            storage: playerStoreStorage,
            version: 5,
        },
    ),
);

export const usePlayerStore = createSelectors(usePlayerStoreBase);

export const usePlayerActions = () => {
    const actions = usePlayerStoreBase(
        useShallow((state) => ({
            addToQueueByType: state.addToQueueByType,
            addToQueueByUniqueId: state.addToQueueByUniqueId,
            clearQueue: state.clearQueue,
            clearSelected: state.clearSelected,
            decreaseVolume: state.decreaseVolume,
            getQueue: state.getQueue,
            increaseVolume: state.increaseVolume,
            isFirstTrackInQueue: state.isFirstTrackInQueue,
            isLastTrackInQueue: state.isLastTrackInQueue,
            mediaAutoNext: state.mediaAutoNext,
            mediaNext: state.mediaNext,
            mediaPause: state.mediaPause,
            mediaPlay: state.mediaPlay,
            mediaPlayByIndex: state.mediaPlayByIndex,
            mediaPrevious: state.mediaPrevious,
            mediaSeekToTimestamp: state.mediaSeekToTimestamp,
            mediaSkipBackward: state.mediaSkipBackward,
            mediaSkipForward: state.mediaSkipForward,
            mediaStop: state.mediaStop,
            mediaToggleMute: state.mediaToggleMute,
            mediaTogglePlayPause: state.mediaTogglePlayPause,
            moveSelectedTo: state.moveSelectedTo,
            moveSelectedToBottom: state.moveSelectedToBottom,
            moveSelectedToNext: state.moveSelectedToNext,
            moveSelectedToTop: state.moveSelectedToTop,
            setPauseOnNextSongEnd: state.setPauseOnNextSongEnd,
            setQueue: state.setQueue,
            setRepeat: state.setRepeat,
            setShuffle: state.setShuffle,
            setVolume: state.setVolume,
            shuffle: state.shuffle,
            shuffleAll: state.shuffleAll,
            shuffleSelected: state.shuffleSelected,
            toggleRepeat: state.toggleRepeat,
            toggleShuffle: state.toggleShuffle,
        })),
    );

    return useMemo(
        () => ({
            ...actions,
            setTimestamp: setTimestampStore,
        }),
        [actions],
    );
};

export type AddToQueueByPlayType = Play;

export type AddToQueueByUniqueId = {
    edge: 'bottom' | 'left' | 'right' | 'top' | null;
    uniqueId: string;
};

export type AddToQueueType = AddToQueueByPlayType | AddToQueueByUniqueId;

export async function addToQueueByData(type: AddToQueueType, data: Song[]) {
    const items = data.map((item) => toQueueSong(item));

    if (typeof type === 'string') {
        usePlayerStoreBase.getState().addToQueueByType(items, type);
    } else {
        const normalizedEdge = type.edge === 'top' ? 'top' : 'bottom';
        usePlayerStoreBase.getState().addToQueueByUniqueId(items, type.uniqueId, normalizedEdge);
    }
}

export const subscribePlayerQueue = (
    onChange: (queue: QueueData, prevQueue: QueueData) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.queue,
        (queue, prevQueue) => {
            onChange(queue, prevQueue);
        },
    );
};

export const subscribeCurrentTrack = (
    onChange: (
        properties: { index: number; song: QueueSong | undefined },
        prev: { index: number; song: QueueSong | undefined },
    ) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => {
            const queue = state.getQueue();
            let index = state.player.index;

            if (isShuffleEnabled(state)) {
                index = mapShuffledToQueueIndex(index, state.queue.shuffled);
            }

            return { index, song: queue.items[index] };
        },
        (song, prevSong) => {
            onChange(song, prevSong);
        },
        {
            equalityFn: (a, b) => {
                return a.song?._uniqueId === b.song?._uniqueId;
            },
        },
    );
};

export const subscribeNextSongInsertion = (onChange: (song: QueueSong | undefined) => void) => {
    return usePlayerStoreBase.subscribe(
        (state) => {
            const queue = state.getQueue();
            let queueIndex = state.player.index;
            const repeat = state.player.repeat;

            // If shuffle is enabled, map shuffled position to actual queue position
            if (isShuffleEnabled(state)) {
                queueIndex = mapShuffledToQueueIndex(queueIndex, state.queue.shuffled);
            }

            const currentSong = queue.items[queueIndex];

            // Calculate next song based on shuffle and repeat settings
            let nextSong: QueueSong | undefined;
            if (isShuffleEnabled(state) && repeat !== PlayerRepeat.ONE) {
                // Calculate next in shuffled order
                const nextShuffledIndex = state.player.index + 1;
                if (nextShuffledIndex < state.queue.shuffled.length) {
                    const nextQueueIndex = state.queue.shuffled[nextShuffledIndex];
                    nextSong = queue.items[nextQueueIndex];
                } else if (repeat === PlayerRepeat.ALL) {
                    // Wrap to first in shuffled order
                    const firstQueueIndex = state.queue.shuffled[0];
                    nextSong = queue.items[firstQueueIndex];
                }
            } else {
                nextSong = calculateNextSong(queueIndex, queue.items, repeat);
            }

            return {
                currentUniqueId: currentSong?._uniqueId,
                nextSong,
            };
        },
        (current, prev) => {
            if (!prev) {
                return;
            }

            // Still on the same track, but the upcoming song changed (queue edit: insert, reorder, etc.).
            // Do not require the current track's queue index to stay fixed — e.g. inserting *before* the
            // current item shifts its index in `queue.default`, and the old check missed that case.
            const sameTrackStillPlaying =
                current.currentUniqueId !== undefined &&
                current.currentUniqueId === prev.currentUniqueId;

            if (sameTrackStillPlaying && current.nextSong?._uniqueId !== prev.nextSong?._uniqueId) {
                onChange(current.nextSong);
            }
        },
        {
            // Always allow the subscription to fire so we can check conditions in the callback
            equalityFn: () => false,
        },
    );
};

export const subscribePlayerVolume = (
    onChange: (properties: { volume: number }, prev: { volume: number }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.volume,
        (volume, prevVolume) => {
            onChange({ volume }, { volume: prevVolume });
        },
    );
};

export const subscribePlayerStatus = (
    onChange: (properties: { status: PlayerStatus }, prev: { status: PlayerStatus }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.status,
        (status, prevStatus) => {
            onChange({ status }, { status: prevStatus });
        },
    );
};

export const subscribePlayerSeekToTimestamp = (
    onChange: (properties: { timestamp: number }, prev: { timestamp: number }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.seekToTimestamp,
        (timestamp, prevTimestamp) => {
            onChange(
                { timestamp: parseUniqueSeekToTimestamp(timestamp) },
                { timestamp: parseUniqueSeekToTimestamp(prevTimestamp) },
            );
        },
    );
};

export const subscribePlayerMute = (
    onChange: (properties: { muted: boolean }, prev: { muted: boolean }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.muted,
        (muted, prevMuted) => {
            onChange({ muted }, { muted: prevMuted });
        },
    );
};

export const subscribePlayerRepeat = (
    onChange: (properties: { repeat: PlayerRepeat }, prev: { repeat: PlayerRepeat }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.repeat,
        (repeat, prevRepeat) => {
            onChange({ repeat }, { repeat: prevRepeat });
        },
    );
};

export const subscribePlayerShuffle = (
    onChange: (properties: { shuffle: PlayerShuffle }, prev: { shuffle: PlayerShuffle }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.shuffle,
        (shuffle, prevShuffle) => {
            onChange({ shuffle }, { shuffle: prevShuffle });
        },
    );
};

export const subscribeQueueCleared = (onChange: () => void) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.queue,
        (queue, prevQueue) => {
            // Detect if queue became empty
            const wasNotEmpty = prevQueue.default.length > 0;
            const isEmpty = queue.default.length === 0;

            if (wasNotEmpty && isEmpty) {
                onChange();
            }
        },
    );
};

export const usePlayerProperties = () => {
    return usePlayerStoreBase(
        useShallow((state) => ({
            isMuted: state.player.muted,
            playerNum: state.player.playerNum,
            repeat: state.player.repeat,
            shuffle: state.player.shuffle,
            status: state.player.status,
            volume: state.player.volume,
        })),
    );
};

export const usePlayerDuration = () => {
    return usePlayerStoreBase((state) => {
        const queue = state.getQueue();
        let index = state.player.index;

        // If shuffle is enabled, map shuffled position to actual queue position
        if (state.player.shuffle === PlayerShuffle.TRACK && state.queue.shuffled.length > 0) {
            if (index >= 0 && index < state.queue.shuffled.length) {
                index = state.queue.shuffled[index];
            }
        }

        const currentTrack = queue.items[index];
        return currentTrack?.duration;
    });
};

export const usePlayerData = (): PlayerData => {
    return usePlayerStoreBase(
        useShallow((state) => {
            const queue = state.getQueue();
            const index = state.player.index;

            // If shuffle is enabled, map shuffled position to actual queue position for display
            let queueIndex = index;
            if (isShuffleEnabled(state)) {
                queueIndex = mapShuffledToQueueIndex(index, state.queue.shuffled);
            }

            const currentSong = queue.items[queueIndex];
            const repeat = state.player.repeat;

            // For previousSong calculation, we need to consider the shuffled order
            let previousSong: QueueSong | undefined;
            if (isShuffleEnabled(state)) {
                // Calculate previous in shuffled order
                const previousShuffledIndex = index - 1;
                if (previousShuffledIndex >= 0) {
                    const previousQueueIndex = state.queue.shuffled[previousShuffledIndex];
                    previousSong = queue.items[previousQueueIndex];
                } else if (repeat === PlayerRepeat.ALL) {
                    // Wrap to last in shuffled order
                    const lastShuffledIndex = state.queue.shuffled.length - 1;
                    const lastQueueIndex = state.queue.shuffled[lastShuffledIndex];
                    previousSong = queue.items[lastQueueIndex];
                }
            } else {
                previousSong = queueIndex > 0 ? queue.items[queueIndex - 1] : undefined;
            }

            // For nextSong calculation, we need to consider the shuffled order
            let nextSong: QueueSong | undefined;
            if (isShuffleEnabled(state) && repeat !== PlayerRepeat.ONE) {
                // Calculate next in shuffled order
                const nextShuffledIndex = index + 1;
                if (nextShuffledIndex < state.queue.shuffled.length) {
                    const nextQueueIndex = state.queue.shuffled[nextShuffledIndex];
                    nextSong = queue.items[nextQueueIndex];
                } else if (repeat === PlayerRepeat.ALL) {
                    // Wrap to first in shuffled order
                    const firstQueueIndex = state.queue.shuffled[0];
                    nextSong = queue.items[firstQueueIndex];
                }
            } else {
                nextSong = calculateNextSong(queueIndex, queue.items, repeat);
            }

            const { player1, player2 } = getDualPlayerSongs(
                state.player.playerNum,
                currentSong,
                nextSong,
                repeat,
            );

            return {
                currentSong,
                index: queueIndex, // Return the actual queue position for display
                nextSong,
                num: state.player.playerNum,
                player1,
                player2,
                previousSong,
                queueLength: state.queue.default.length,
                status: state.player.status,
            };
        }),
    );
};

export const updateQueueFavorites = (ids: string[], favorite: boolean) => {
    usePlayerStoreBase.setState((state) => {
        Object.values(state.queue.songs).forEach((song) => {
            if (ids.includes(song.id)) {
                song.userFavorite = favorite;
            }
        });
    });
};

export const updateQueueRatings = (ids: string[], rating: null | number) => {
    usePlayerStoreBase.setState((state) => {
        Object.values(state.queue.songs).forEach((song) => {
            if (ids.includes(song.id)) {
                song.userRating = rating;
            }
        });
    });
};

export const incrementQueuePlayCount = (ids: string[]) => {
    usePlayerStoreBase.setState((state) => {
        Object.values(state.queue.songs).forEach((song) => {
            if (ids.includes(song.id)) {
                song.playCount = (song.playCount || 0) + 1;
            }
        });
    });
};

export const updateQueueSong = (songId: string, updatedSong: Song) => {
    usePlayerStoreBase.setState((state) => {
        Object.values(state.queue.songs).forEach((song) => {
            if (song.id === songId) {
                const uniqueId = song._uniqueId;
                state.queue.songs[song._uniqueId] = {
                    ...updatedSong,
                    _contextPlaylistId: song._contextPlaylistId,
                    // Kept deliberately: refreshing a song's metadata must not
                    // quietly evict it from the lane.
                    _manual: song._manual,
                    _uniqueId: uniqueId,
                };
            }
        });
    });
};

export const useCurrentPlaylistContextId = () => {
    return usePlayerStoreBase((state) => state.getCurrentSong()?._contextPlaylistId ?? null);
};

export const usePlayerMuted = () => {
    return usePlayerStoreBase((state) => state.player.muted);
};

export const usePlayerRepeat = () => {
    return usePlayerStoreBase((state) => state.player.repeat);
};

export const usePlayerShuffle = () => {
    return usePlayerStoreBase((state) => state.player.shuffle);
};

export const usePlayerStatus = () => {
    return usePlayerStoreBase((state) => state.player.status);
};

export const usePlayerHydrated = () => {
    return usePlayerStoreBase((state) => state.hydrated);
};

export const usePlayerVolume = () => {
    return usePlayerStoreBase((state) => state.player.volume);
};

export const usePlayerSong = () => {
    return usePlayerStoreBase(
        (state) => {
            return state.getCurrentSong();
        },
        (prev, next) => {
            return (
                prev?._uniqueId === next?._uniqueId &&
                prev?.userFavorite === next?.userFavorite &&
                prev?.userRating === next?.userRating
            );
        },
    );
};

export const usePlayerSongProperties = <T extends keyof QueueSong>(
    properties: T[],
): Partial<Pick<QueueSong, T>> => {
    return usePlayerStoreBase(
        useShallow((state) => {
            const song = state.getCurrentSong();
            if (!song) {
                return {};
            }

            const result = {} as Pick<QueueSong, T>;

            for (const prop of properties) {
                result[prop] = song[prop];
            }
            return result;
        }),
    );
};

export const usePlayerNum = () => {
    return usePlayerStoreBase((state) => state.player.playerNum);
};

export const usePlayerQueue = () => {
    return usePlayerStoreBase(
        useShallow((state) => {
            const songs = state.queue.songs;
            const queue = state.queue.default;
            const result: QueueSong[] = [];
            for (const id of queue) {
                const song = songs[id];
                if (song) result.push(song);
            }
            return result;
        }),
    );
};

function cleanupOrphanedSongs(state: any): boolean {
    const allQueueIds = new Set([
        ...state.queue.default,
        // shuffled now contains indexes, not uniqueIds, so we don't include it here
    ]);

    const songs = state.queue.songs;
    const songIds = Object.keys(songs);
    let hasOrphans = false;
    const orphanedIds: string[] = [];

    for (const songId of songIds) {
        if (!allQueueIds.has(songId)) {
            orphanedIds.push(songId);
            hasOrphans = true;
        }
    }

    if (hasOrphans) {
        const cleanedSongs: Record<string, QueueSong> = {};
        for (const songId of songIds) {
            if (!orphanedIds.includes(songId)) {
                cleanedSongs[songId] = songs[songId];
            }
        }
        state.queue.songs = cleanedSongs;
    }

    return hasOrphans;
}

function findIndexWithPreviousAlbum(queueItems: QueueSong[], currentIndex: number) {
    const queueBeforeCurrent = queueItems.slice(0, currentIndex);
    const currentItem = queueItems[currentIndex];

    const previousAlbumIdInQueue = queueBeforeCurrent.findLast(
        (i) => i.albumId !== currentItem.albumId,
    )?.albumId;

    let prevIndex = -1;

    if (previousAlbumIdInQueue) {
        for (let index = queueBeforeCurrent.length - 1; index > -1; index--) {
            const element = queueBeforeCurrent[index];
            if (element.albumId === previousAlbumIdInQueue) {
                prevIndex = index;
            }
            if (prevIndex > -1 && element.albumId !== previousAlbumIdInQueue) {
                break;
            }
        }
    }

    return prevIndex;
}

function findLastAlbumRange(queueItems: QueueSong[]) {
    const lastAlbumId = queueItems.at(-1)?.albumId;
    const rangeEnd = queueItems.length - 1;
    let rangeStart = rangeEnd;

    for (let index = rangeEnd; index > -1; index--) {
        const element = queueItems[index];
        rangeStart = index;
        if (element.albumId !== lastAlbumId) {
            break;
        }
    }

    return [rangeStart + 1, rangeEnd];
}

function parseUniqueSeekToTimestamp(timestamp: string) {
    return Number(timestamp.split('-')[0]);
}

function recalculatePlayerIndex(state: any, queue: string[]) {
    const currentTrack = state.getCurrentSong() as QueueSong | undefined;

    if (!currentTrack) {
        return;
    }

    const index = queue.findIndex((id) => id === currentTrack._uniqueId);
    state.player.index = Math.max(0, index);
}

/**
 * `manual` marks the entry as one the listener put here themselves, with Play
 * Next or Play Last. It decides the lane, and it stays on this device.
 */
function toQueueSong(item: Song, manual = false): QueueSong {
    const entry: QueueSong = {
        ...item,
        _uniqueId: nanoid(),
    };

    if (manual) {
        entry._manual = true;
    }

    return entry;
}

// We need to use a unique id so that the equalityFn can work if attempting to set the same timestamp
function uniqueSeekToTimestamp(timestamp: number) {
    return `${timestamp}-${nanoid()}`;
}
