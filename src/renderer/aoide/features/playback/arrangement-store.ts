import type { Arrangement } from '/@/shared/aoide/arrangement';

import { MeasurementStore, useMeasurement, useMeasurementPrefetch } from './measurement-store';

import { useAoideAutoDjEnabled } from '/@/renderer/aoide/features/playback/use-auto-dj';

/**
 * This session's memory of every track's arrangement, gated by Auto DJ like
 * the grid. A pair whose arrangements have not arrived is not mixed —
 * matching tempo is not a substitute for knowing the music — so this is asked
 * for alongside the grid, never after it.
 */
export const arrangementStore = new MeasurementStore<Arrangement>(async (ids, client) => {
    const answer = await client.arrangements(ids);
    return { absent: answer.absent, pending: answer.pending, rows: answer.arrangements };
}, 'Aoide could not fetch arrangements; tracks crossfade');

/** A track's arrangement: null for "nothing to say", undefined for "not known yet". */
export const useArrangement = (trackId: string | undefined): Arrangement | null | undefined =>
    useMeasurement(arrangementStore, trackId, useAoideAutoDjEnabled());

/** Arrangements for the tracks coming up, asked for ahead of time. */
export const useArrangementPrefetch = (trackIds: readonly string[]): void =>
    useMeasurementPrefetch(arrangementStore, trackIds, useAoideAutoDjEnabled());
