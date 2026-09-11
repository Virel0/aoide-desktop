import type { BeatGrid } from '/@/shared/aoide/beat-grid';

import { MeasurementStore, useMeasurement, useMeasurementPrefetch } from './measurement-store';

import { useAoideAutoDjEnabled } from '/@/renderer/aoide/features/playback/use-auto-dj';

/**
 * This session's memory of every track's beat grid. Gated by Auto DJ: with it
 * off nothing is asked for and nothing is known, so nothing downstream can
 * plan a mix.
 */
export const beatGridStore = new MeasurementStore<BeatGrid>(async (ids, client) => {
    const answer = await client.beatGrids(ids);
    return { absent: answer.absent, pending: answer.pending, rows: answer.grids };
}, 'Aoide could not fetch beat grids; tracks crossfade');

/** A track's grid: null for "no grid worth having", undefined for "not known yet". */
export const useBeatGrid = (trackId: string | undefined): BeatGrid | null | undefined =>
    useMeasurement(beatGridStore, trackId, useAoideAutoDjEnabled());

/** Grids for the tracks coming up, asked for ahead of time. */
export const useBeatGridPrefetch = (trackIds: readonly string[]): void =>
    useMeasurementPrefetch(beatGridStore, trackIds, useAoideAutoDjEnabled());
