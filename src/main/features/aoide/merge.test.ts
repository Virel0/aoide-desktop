import { describe, expect, it } from 'vitest';

import type { CurationRow } from './curation-store';

import { correctForSkew, mergeRows, rowWinner, stampsFromRow } from './merge';

const row = (overrides: Partial<CurationRow> = {}): CurationRow => ({
    deleted: 0,
    description: null,
    id: 'playlist-1',
    name: 'Driving',
    origin_device: 'device-a',
    sort_index: 'a0',
    updated_at: 1000,
    ...overrides,
});

describe('rowWinner', () => {
    it('takes the later write', () => {
        expect(rowWinner(row({ updated_at: 2000 }), row({ updated_at: 1000 }))).toBe('incoming');
        expect(rowWinner(row({ updated_at: 1000 }), row({ updated_at: 2000 }))).toBe('existing');
    });

    // Which side wins is arbitrary. That every device reaches the SAME answer
    // is the entire property — two devices resolving one conflict differently
    // diverge permanently, and nothing afterwards notices.
    it('breaks a tie the same way regardless of which side is which', () => {
        const a = row({ origin_device: 'device-a' });
        const b = row({ origin_device: 'device-b' });

        expect(rowWinner(b, a)).toBe('incoming'); // b arrives at a's device
        expect(rowWinner(a, b)).toBe('existing'); // a arrives at b's device
        // Both devices keep b. They agree.
    });

    it('keeps what is stored when the same write arrives again', () => {
        expect(rowWinner(row(), row())).toBe('existing');
    });
});

describe('correctForSkew', () => {
    // The rule that stops a NAS without a real-time clock from wedging every
    // device: BOTH references must disagree with the timestamp.
    it('leaves a timestamp alone when only the server thinks it is ahead', () => {
        // Slow server (behind), healthy local clock. The writer is not at fault.
        expect(correctForSkew(5000, 3000, 9000)).toBe(5000);
    });

    it('leaves a timestamp alone when only the local clock thinks it is ahead', () => {
        // This device is behind; the server agrees with the writer.
        expect(correctForSkew(5000, 9000, 3000)).toBe(5000);
    });

    it('disbelieves a timestamp ahead of both references', () => {
        expect(correctForSkew(9999, 3000, 4000)).toBe(3000);
    });

    it('corrects to the more conservative of the two references', () => {
        expect(correctForSkew(9999, 5000, 4000)).toBe(4000);
    });

    // The contract does not currently carry receivedAt. Correcting against the
    // local clock alone is exactly the failure this rule exists to prevent.
    it('corrects nothing when the server gave no receipt time', () => {
        expect(correctForSkew(9999, undefined, 1000)).toBe(9999);
    });
});

describe('per-field merge', () => {
    const merge = (
        incoming: CurationRow,
        existing: CurationRow,
        stamps = {},
        existingStamps = {},
    ) =>
        mergeRows({
            entity: 'playlists',
            existing,
            existingStamps,
            incoming,
            incomingStamps: stamps,
        });

    // The case the whole mechanism exists for.
    it('lets two devices each win the field they edited', () => {
        const existing = row({
            description: 'for the motorway',
            name: 'Driving',
            origin_device: 'device-a',
            updated_at: 2000,
        });
        const incoming = row({
            description: null,
            name: 'Road Trip',
            origin_device: 'device-b',
            updated_at: 3000,
        });

        const merged = merge(
            incoming,
            existing,
            { description: 500, name: 3000 },
            { description: 2000, name: 500 },
        );

        expect(merged.row.name).toBe('Road Trip'); // device B's rename, newer
        expect(merged.row.description).toBe('for the motorway'); // device A's, newer
    });

    // The bug that made two iOS devices diverge permanently: a tie that keeps
    // the stored value means each device keeps its own and both think they
    // merged.
    it('resolves a tied field to the row winner, not to whatever was stored', () => {
        const a = row({ name: 'A-side', origin_device: 'device-a', updated_at: 1000 });
        const b = row({ name: 'B-side', origin_device: 'device-b', updated_at: 1000 });

        const onDeviceA = merge(b, a); // b arrives at a
        const onDeviceB = merge(a, b); // a arrives at b

        expect(onDeviceA.row.name).toBe(onDeviceB.row.name);
        expect(onDeviceA.row.name).toBe('B-side');
    });

    it('does not synthesise a stamp map out of two unstamped rows', () => {
        const merged = merge(row({ updated_at: 2000 }), row({ updated_at: 1000 }));
        expect(merged.stamps).toBeNull();
    });

    // Absent is not null. An older build that has never heard of a column must
    // not erase it — this is how a cover disappears when an older device
    // renames a playlist.
    it('keeps a column the incoming payload does not know about', () => {
        const existing = row({ image_hash: 'abc123', updated_at: 1000 });
        const incoming = row({ name: 'Renamed', updated_at: 5000 });
        delete incoming.image_hash;

        const merged = merge(incoming, existing);

        expect(merged.row.image_hash).toBe('abc123');
        expect(merged.row.name).toBe('Renamed');
    });

    it('accepts a column the stored row does not have yet', () => {
        const existing = row({ updated_at: 1000 });
        delete existing.image_hash;
        const incoming = row({ image_hash: 'new', updated_at: 5000 });

        expect(merge(incoming, existing).row.image_hash).toBe('new');
    });

    it('reports no change when the merge reproduces what is stored', () => {
        expect(merge(row(), row()).changed).toBe(false);
    });

    it('carries the row forward at the later of the two timestamps', () => {
        const merged = merge(row({ updated_at: 3000 }), row({ updated_at: 1000 }));
        expect(merged.row.updated_at).toBe(3000);
    });
});

describe('row-level merge', () => {
    const merge = (incoming: CurationRow, existing: CurationRow) =>
        mergeRows({
            entity: 'likes',
            existing,
            existingStamps: {},
            incoming,
            incomingStamps: {},
        });

    it('takes the whole newer row', () => {
        const merged = merge(row({ liked: 1, updated_at: 2000 }), row({ liked: 0, updated_at: 1 }));
        expect(merged.row.liked).toBe(1);
        expect(merged.changed).toBe(true);
    });

    // queue_state is excluded from per-field deliberately: pairing one device's
    // playback position with another device's track list describes a state that
    // existed on neither.
    it('never mixes fields for queue_state', () => {
        const existing: CurationRow = {
            device_id: 'device-a',
            elapsed_ms: 90_000,
            origin_device: 'device-a',
            position: 7,
            track_ids: '["old"]',
            updated_at: 1000,
        };
        const incoming: CurationRow = {
            device_id: 'device-a',
            elapsed_ms: 0,
            origin_device: 'device-a',
            position: 0,
            track_ids: '["new"]',
            updated_at: 2000,
        };

        const merged = mergeRows({
            entity: 'queue_state',
            existing,
            existingStamps: {},
            incoming,
            incomingStamps: {},
        });

        expect(merged.row.track_ids).toBe('["new"]');
        expect(merged.row.position).toBe(0);
        expect(merged.row.elapsed_ms).toBe(0);
    });
});

describe('stampsFromRow', () => {
    it('treats a row with no stamps as having none', () => {
        expect(stampsFromRow(row())).toEqual({});
    });

    it('survives a stamp map that will not parse', () => {
        expect(stampsFromRow(row({ field_updated_at: '{not json' }))).toEqual({});
    });

    it('ignores non-numeric stamps rather than comparing against them', () => {
        expect(stampsFromRow(row({ field_updated_at: '{"name":"soon","description":5}' }))).toEqual(
            {
                description: 5,
            },
        );
    });
});
