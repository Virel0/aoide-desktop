import type { TrimPlan } from '/@/shared/aoide/trim-plan';

import { describe, expect, it } from 'vitest';

import { initialTracker, RESTART_GAP_SEC, step, TrackerState } from './trim-tracker';

const PLAN = { endSec: 312.2, startSec: 1.94 };

/** Feed progress samples in order; return every action issued. */
const run = (
    samples: number[],
    plan: null | TrimPlan = PLAN,
    from: TrackerState = initialTracker(),
) => {
    let state = from;
    const actions: unknown[] = [];
    for (const sec of samples) {
        const result = step(state, plan, sec);
        state = result.state;
        if (result.action) actions.push(result.action);
    }
    return { actions, state };
};

describe('the trim tracker', () => {
    it('seeks to the start once, on the first sample before it', () => {
        expect(run([0, 0.25, 0.5]).actions).toEqual([{ kind: 'seek', toSec: 1.94 }]);
    });

    it('ends once at the bound and not again after it', () => {
        expect(run([300, 312, 312.2, 312.5, 313]).actions).toEqual([{ kind: 'advance' }]);
    });

    // A track picked up in the middle, or one whose bounds arrived late.
    it('does not seek forward over music that is already playing', () => {
        expect(run([10, 10.25]).actions).toEqual([]);
    });

    it('does nothing without a plan', () => {
        expect(run([0, 312.5], null).actions).toEqual([]);
    });

    it('does not seek when the plan has no lead-in', () => {
        expect(run([0, 0.25], { endSec: 312.2, startSec: 0 }).actions).toEqual([]);
    });

    it('does not end when the plan has no tail', () => {
        expect(run([0, 400], { endSec: null, startSec: 1.94 }).actions).toEqual([
            { kind: 'seek', toSec: 1.94 },
        ]);
    });

    // Repeat One loops the element back to zero; a person drags to the intro.
    it('owes the seek and the end again after a restart', () => {
        const { actions } = run([0, 100, 312.2, 0, 0.25, 312.2]);
        expect(actions).toEqual([
            { kind: 'seek', toSec: 1.94 },
            { kind: 'advance' },
            { kind: 'seek', toSec: 1.94 },
            { kind: 'advance' },
        ]);
    });

    it('does not mistake the player settling after a seek for a restart', () => {
        const { state } = run([100]);
        const settled = step(state, PLAN, 100 - RESTART_GAP_SEC + 0.1);
        expect(settled.state.seeked).toBe(state.seeked);
        expect(settled.state.advanced).toBe(state.advanced);
        const restarted = step(state, PLAN, 100 - RESTART_GAP_SEC - 0.1);
        expect(restarted.state.seeked).toBe(false);
    });

    it('does not seek again after the seek, even while the player catches up', () => {
        // After seeking to 1.94 the player may report 0.3 once more before it lands.
        expect(run([0, 0.3, 1.94, 2.2]).actions).toEqual([{ kind: 'seek', toSec: 1.94 }]);
    });
});
