import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    DEFAULT_NOW_PLAYING_TAB,
    parseNowPlayingTab,
    useNowPlayingTabStore,
} from './use-now-playing-tab';

const read = (relative: string) => readFileSync(join(import.meta.dirname, relative), 'utf8');

describe('what the Now Playing column opens on', () => {
    it('is the queue', () => {
        expect(DEFAULT_NOW_PLAYING_TAB).toBe('queue');
        expect(useNowPlayingTabStore.getState().tab).toBe('queue');
    });

    it('remembers what was chosen', () => {
        useNowPlayingTabStore.getState().setTab('lyrics');
        expect(useNowPlayingTabStore.getState().tab).toBe('lyrics');
        useNowPlayingTabStore.getState().setTab('queue');
        expect(useNowPlayingTabStore.getState().tab).toBe('queue');
    });

    // localStorage is a file on disk that other versions of this app have
    // written to; anything unrecognisable in it means the preference was never
    // set, not that the column should render nothing.
    it('treats anything else in storage as unset', () => {
        expect(parseNowPlayingTab('lyrics')).toBe('lyrics');
        expect(parseNowPlayingTab('Queue')).toBe('queue');
        expect(parseNowPlayingTab(undefined)).toBe('queue');
        expect(parseNowPlayingTab(null)).toBe('queue');
        expect(parseNowPlayingTab(7)).toBe('queue');
    });

    it('is where the column actually reads its tab from', () => {
        const column = read('./aoide-now-playing-column.tsx');
        expect(column).toContain('useNowPlayingTab()');
        expect(column).not.toContain("useState<Tab>('lyrics')");
    });
});
