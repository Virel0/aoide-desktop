import type { TrimPlan } from '/@/shared/aoide/trim-plan';

import { shouldAdvance } from '/@/shared/aoide/trim-plan';

/**
 * One player slot's progress against its trim plan: seek once at the start,
 * end once at the end, and start over when the track does.
 *
 * Pure. The web player feeds it a progress sample and does what it says; the
 * "once" is the whole reason it exists. A progress event arrives four times
 * a second, and a seek or an end issued on every one of them past the bound
 * would fight the player — the seek re-issued after the person dragged back
 * to the intro, the end re-issued while the next track was already loading.
 */

export interface TrackerState {
    /** The end was issued for this run of the track. */
    advanced: boolean;
    /** The last progress seen, to notice a restart. */
    lastSec: number;
    /** The start seek was issued for this run of the track. */
    seeked: boolean;
}

export type TrimAction = null | { kind: 'advance' } | { kind: 'seek'; toSec: number };

/**
 * A jump back of more than this is a restart — a loop under Repeat One, or a
 * person dragging to the beginning — and the seek and the end are owed again.
 * Smaller jumps are the player settling after a seek.
 */
export const RESTART_GAP_SEC = 5;

export const initialTracker = (): TrackerState => ({ advanced: false, lastSec: 0, seeked: false });

/**
 * Only seek from *before* the sound: a track picked up in the middle, or one
 * whose bounds arrived late, is left where it is. A seek forward over music
 * that is playing would be a skip nobody asked for.
 */
export const step = (
    state: TrackerState,
    plan: null | TrimPlan,
    playedSec: number,
): { action: TrimAction; state: TrackerState } => {
    const restarted = playedSec < state.lastSec - RESTART_GAP_SEC;
    const next: TrackerState = restarted
        ? { advanced: false, lastSec: playedSec, seeked: false }
        : { ...state, lastSec: playedSec };

    if (!plan) return { action: null, state: next };

    if (plan.startSec > 0 && !next.seeked && playedSec < plan.startSec) {
        return { action: { kind: 'seek', toSec: plan.startSec }, state: { ...next, seeked: true } };
    }

    if (!next.advanced && shouldAdvance(playedSec, plan.endSec)) {
        return { action: { kind: 'advance' }, state: { ...next, advanced: true } };
    }

    return { action: null, state: next };
};
