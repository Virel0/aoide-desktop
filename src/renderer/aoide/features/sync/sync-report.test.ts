import { describe, expect, it } from 'vitest';

import {
    syncMessages,
    syncOutcome,
    syncReportEntries,
} from '/@/renderer/aoide/features/sync/sync-report';
import { SyncError } from '/@/renderer/aoide/sync/errors';
import { SyncResult } from '/@/renderer/aoide/sync/sync-engine';

const emptyResult = (overrides: Partial<SyncResult> = {}): SyncResult => ({
    applied: 0,
    blocked: [],
    cursor: 0,
    foreignAuthors: [],
    heldBack: [],
    imageErrors: [],
    pulled: 0,
    pushed: 0,
    quarantined: [],
    revoked: [],
    uploaded: [],
    ...overrides,
});

const entryFor = (result: SyncResult, key: string) =>
    syncReportEntries(result).find((entry) => entry.key === key);

describe('syncOutcome', () => {
    it('says nothing was synced when only the reachability check ran', () => {
        // The fallback path sets `finishedAt` exactly as a real sync does, which
        // is how the panel came to say "Last synced" after moving no ops at all.
        const outcome = syncOutcome({
            finishedAt: 1_700_000_000_000,
            phase: 'success',
            status: { cursor: 42 },
        });

        expect(outcome).toBe('checked');
    });

    it('claims a sync only when the loop actually ran', () => {
        expect(syncOutcome({ finishedAt: 1, phase: 'success', result: emptyResult() })).toBe(
            'synced',
        );
    });

    it('claims neither synced nor checked after a failure that produced no result', () => {
        // 'failed' rather than 'idle': the run did happen, and saying "not synced
        // yet" of a run that just failed reads as though nothing was attempted.
        // What this has always forbidden — claiming a sync or a reachability
        // check that did not happen — still holds.
        expect(syncOutcome({ error: 'boom', finishedAt: 1, phase: 'error' })).toBe('failed');
    });

    it('reports a run in flight before anything it may still be carrying', () => {
        expect(syncOutcome({ phase: 'running', result: emptyResult() })).toBe('running');
    });
});

describe('syncMessages', () => {
    it('keeps a fatal failure in the server’s own words', () => {
        const messages = syncMessages(
            emptyResult({
                pullError: new SyncError('permanent', 'Pull failed', {
                    body: 'playlist p1 is not yours',
                    status: 403,
                }),
            }),
        );

        expect(messages.error).toContain('playlist p1 is not yours');
        expect(messages.warning).toBeUndefined();
    });

    /*
     * The panel drew a shareError in the error colour while the status line said
     * the sync had succeeded — `syncFailed` does not count it, so both were on
     * screen at once. It is survivable news and now says so.
     */
    it('does not report a share-list failure as a fatal error', () => {
        const messages = syncMessages(
            emptyResult({ shareError: new SyncError('transient', 'Share list unreadable') }),
        );

        expect(messages.error).toBeUndefined();
        expect(messages.warning).toBe('Share list unreadable');
    });

    it('leaves both unset when nothing went wrong', () => {
        expect(syncMessages(emptyResult())).toEqual({ error: undefined, warning: undefined });
    });
});

describe('syncReportEntries', () => {
    it('says why an edit was quarantined, not just how many were', () => {
        const entry = entryFor(
            emptyResult({
                quarantined: [
                    { kind: 'quarantine', opId: 'o1', reason: 'Unknown column "notes"' },
                    { kind: 'quarantine', opId: 'o2', reason: 'Position must be a string' },
                ],
            }),
            'aoide.sync.quarantined',
        );

        expect(entry?.count).toBe(2);
        expect(entry?.detail).toBe('Unknown column "notes"\nPosition must be a string');
    });

    // Bisecting a 5xx quarantines each op on its own, so one sentence arrives
    // once per op. The count is the news; ten copies of it are not.
    it('says a repeated reason once', () => {
        const entry = entryFor(
            emptyResult({
                quarantined: [
                    { kind: 'quarantine', opId: 'o1', reason: 'Server exploded' },
                    { kind: 'quarantine', opId: 'o2', reason: 'Server exploded' },
                ],
            }),
            'aoide.sync.quarantined',
        );

        expect(entry?.count).toBe(2);
        expect(entry?.detail).toBe('Server exploded');
    });

    it('still counts a refusal the server declined to explain', () => {
        const entry = entryFor(
            emptyResult({ quarantined: [{ kind: 'quarantine', opId: 'o1', reason: '' }] }),
            'aoide.sync.quarantined',
        );

        expect(entry?.count).toBe(1);
        expect(entry?.detail).toBeUndefined();
    });

    it('says why an edit is stuck behind a revoked share', () => {
        const entry = entryFor(
            emptyResult({
                blocked: [
                    {
                        opId: 'o1',
                        playlistId: 'p1',
                        reason: "Playlist 'p1' belongs to another user and is not shared with you for editing.",
                        stillShared: false,
                    },
                ],
            }),
            'aoide.sync.blocked',
        );

        expect(entry?.count).toBe(1);
        expect(entry?.detail).toContain('is not shared with you for editing');
    });

    /*
     * `revoked` is empty on every run after the refusal — the op is no longer
     * pushed, so nothing can refuse it again — while `blocked` keeps naming it.
     * Reading the wrong one mentions a lost edit once and then goes quiet.
     */
    it('still reports an edit blocked by an earlier run', () => {
        const stuck = {
            opId: 'o1',
            playlistId: 'p1',
            reason: 'Share revoked',
            stillShared: false,
        };

        const entry = entryFor(
            emptyResult({ blocked: [stuck], revoked: [] }),
            'aoide.sync.blocked',
        );

        expect(entry?.count).toBe(1);
    });

    it('says why a cover would not upload, beside the changes waiting on it', () => {
        const entries = syncReportEntries(
            emptyResult({
                heldBack: ['o1'],
                imageErrors: [new SyncError('transient', 'PUT /images timed out')],
            }),
        );

        expect(entries.map((entry) => entry.key)).toEqual([
            'aoide.sync.heldBack',
            'aoide.sync.imageErrors',
        ]);
        expect(entries[1].detail).toBe('PUT /images timed out');
    });

    it('reports nothing at all for a clean run', () => {
        expect(syncReportEntries(emptyResult())).toEqual([]);
    });
});
