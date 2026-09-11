import type { MixStatus } from '/@/renderer/aoide/features/playback/buffer-deck';

import { useSyncExternalStore } from 'react';

/**
 * What the Now Playing column says about the mix in front of us: nothing, a
 * mix booked and how long until it starts, or a mix under way and how far
 * through. Written by the deck's tick, read by the indicator; the deck knows
 * the audio clock and the column does not, so the progress arrives as a
 * fraction rather than as two times.
 */
class DJStatusStore {
    private listeners = new Set<() => void>();
    private status: MixStatus | null = null;

    get(): MixStatus | null {
        return this.status;
    }

    set(status: MixStatus | null): void {
        const before = this.status;
        if (
            before?.phase === status?.phase &&
            before?.bars === status?.bars &&
            before?.progress === status?.progress
        ) {
            return;
        }
        this.status = status;
        for (const listener of this.listeners) listener();
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
}

export const djStatusStore = new DJStatusStore();

export const useDJStatus = (): MixStatus | null =>
    useSyncExternalStore(djStatusStore.subscribe, () => djStatusStore.get());
