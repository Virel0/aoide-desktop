import { describe, expect, it } from 'vitest';

import { FOCUS_SYNC_MIN_INTERVAL_MS, isFocusSyncDue } from './sync-schedule';

describe('isFocusSyncDue', () => {
    const MINUTE = 60_000;

    it('never holds back the first sync of a session', () => {
        expect(isFocusSyncDue(undefined, 0)).toBe(true);
    });

    it('refuses a second sync inside the interval', () => {
        expect(isFocusSyncDue(1_000, 1_000 + MINUTE - 1)).toBe(false);
    });

    it('allows one exactly at the interval', () => {
        expect(isFocusSyncDue(1_000, 1_000 + MINUTE)).toBe(true);
    });

    it('allows one after the interval', () => {
        expect(isFocusSyncDue(1_000, 1_000 + 5 * MINUTE)).toBe(true);
    });

    // Measured from when the previous run started rather than when it ended,
    // so a run that takes a while does not push the next one further out.
    it('measures from the previous start', () => {
        expect(isFocusSyncDue(0, MINUTE, MINUTE)).toBe(true);
        expect(isFocusSyncDue(0, MINUTE - 1, MINUTE)).toBe(false);
    });

    // A music player is left open for days, and every alt-tab is a focus event.
    // Anything under a minute turns window switching into a request stream.
    it('waits at least a minute between focus syncs by default', () => {
        expect(FOCUS_SYNC_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(MINUTE);
    });
});
