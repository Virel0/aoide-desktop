import type { QueueEntry } from '/@/shared/aoide/sync-types';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { useSidecarTransport } from '/@/renderer/aoide/features/sync/use-sidecar-transport';
import { usePlayerStore } from '/@/renderer/store';

/**
 * Writing this device's queue down, so another one can pick it up.
 *
 * Saved when the queue or the track genuinely changes, not on a timer and not on
 * every position tick. The sidecar compacts superseded rows on push, so saving
 * often is free; saving *rarely* is what costs, because a handover offers
 * whatever was last written and a queue saved only on quit is wrong exactly when
 * somebody reaches for their other machine.
 */
export const useQueueBroadcast = (deviceName: string): void => {
    const queue = usePlayerStore((state) => state.queue.default);
    const index = usePlayerStore((state) => state.player.index);
    const lastSaved = useRef('');

    useEffect(() => {
        if (!isAoideAvailable() || queue.length === 0) return;

        // The identity of the queue plus where we are in it. Elapsed time is
        // deliberately not part of this: including it would write a row every
        // second, and a handover that resumes a few seconds early is not a
        // problem anybody has.
        const signature = `${queue.length}:${queue[0]}:${queue[queue.length - 1]}:${index}`;
        if (signature === lastSaved.current) return;
        lastSaved.current = signature;

        void window.api.aoide.queue.save(deviceName, queue, index, 0);
    }, [deviceName, index, queue]);
};

export interface Handoff {
    ageSeconds: number;
    deviceId: string;
    deviceName: string;
    position: number;
    /**
     * This device's clock when `ageSeconds` was measured. The age is only
     * meaningful relative to that instant, so anything comparing it to local
     * timestamps starts from here rather than from whenever it happens to render.
     */
    receivedAt: number;
    trackIds: string[];
}

/**
 * The queue worth offering to pick up, if there is one.
 *
 * Asks the sidecar first, because only the server can say how recent a row is
 * without trusting the clock of the device that wrote it — a machine set wrong
 * would otherwise claim to be the most recent one forever and win every
 * handover. Falls back to what the op log already brought, which still works
 * with no network, just ordered by the writer's own clock.
 */
export const useHandoff = (): Handoff | null => {
    const transport = useSidecarTransport();

    const { data } = useQuery({
        enabled: isAoideAvailable(),
        queryFn: async (): Promise<Handoff | null> => {
            const found = (await fromSidecar(transport)) ?? (await fromLocalRows());
            return found ? { ...found, receivedAt: Date.now() } : null;
        },
        queryKey: ['aoide', 'handoff'],
        // Long enough not to poll, short enough that picking up the phone and
        // walking to the desk finds something. Refetched on focus, which is the
        // moment somebody has actually arrived.
        refetchOnWindowFocus: true,
        staleTime: 30_000,
    });

    return data ?? null;
};

const fromSidecar = async (
    transport: ReturnType<typeof useSidecarTransport>,
): Promise<null | Omit<Handoff, 'receivedAt'>> => {
    if (!transport) return null;

    try {
        const entries = await transport.queues();
        const other = entries.find(
            (entry: QueueEntry) => !entry.isCurrentDevice && (entry.trackIds?.length ?? 0) > 0,
        );

        if (!other) return null;

        return {
            ageSeconds: other.ageSeconds,
            deviceId: other.deviceId,
            deviceName: other.deviceName ?? 'Another device',
            position: other.position ?? 0,
            trackIds: other.trackIds ?? [],
        };
    } catch {
        // A sidecar that cannot be reached is not an error worth showing on a
        // music player. The local rows are the answer.
        return null;
    }
};

const fromLocalRows = async (): Promise<null | Omit<Handoff, 'receivedAt'>> => {
    const rows = await window.api.aoide.queue.others();
    const row = rows.find((candidate) => {
        const ids = parseTrackIds(candidate.trackIds);
        return ids.length > 0;
    });

    if (!row) return null;

    return {
        // Derived from the writing device's clock, which is the best available
        // without the server. Named the same way so the screen need not care.
        ageSeconds: Math.max(0, (Date.now() - Number(row.updatedAt ?? 0)) / 1000),
        deviceId: String(row.deviceId),
        deviceName: String(row.deviceName ?? 'Another device'),
        position: Number(row.position ?? 0),
        trackIds: parseTrackIds(row.trackIds),
    };
};

/** Track ids travel as a JSON array in a text column, on both clients. */
const parseTrackIds = (value: unknown): string[] => {
    if (typeof value !== 'string') return [];

    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((id): id is string => typeof id === 'string')
            : [];
    } catch {
        return [];
    }
};
