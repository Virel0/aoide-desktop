import { persist } from 'zustand/middleware';
import { createWithEqualityFn } from 'zustand/traditional';

/** What the bottom half of the Now Playing column is showing. */
export type NowPlayingTab = 'lyrics' | 'queue';

/**
 * The queue, not the lyrics.
 *
 * The column replaced the side queue, and the queue is what that space was for:
 * what is coming, what to drag, what to remove. Lyrics are worth looking at for
 * one song at a time and are one click away; the queue is the thing somebody has
 * open while doing something else, and opening on lyrics meant clicking back to
 * it every time the app started.
 */
export const DEFAULT_NOW_PLAYING_TAB: NowPlayingTab = 'queue';

const isTab = (value: unknown): value is NowPlayingTab => value === 'lyrics' || value === 'queue';

/** Anything else in storage is treated as never having been set. */
export const parseNowPlayingTab = (value: unknown): NowPlayingTab =>
    isTab(value) ? value : DEFAULT_NOW_PLAYING_TAB;

interface NowPlayingTabState {
    setTab: (tab: NowPlayingTab) => void;
    tab: NowPlayingTab;
}

/**
 * Remembered, because it is a preference rather than a default: somebody who
 * reads along with lyrics reads along with them tomorrow too. Device-local, like
 * every other piece of "how this window is arranged" state.
 */
export const useNowPlayingTabStore = createWithEqualityFn<NowPlayingTabState>()(
    persist(
        (set) => ({
            setTab: (tab) => set({ tab: parseNowPlayingTab(tab) }),
            tab: DEFAULT_NOW_PLAYING_TAB,
        }),
        { name: 'aoide-now-playing-tab', version: 1 },
    ),
);

export const useNowPlayingTab = (): NowPlayingTab =>
    useNowPlayingTabStore((state) => parseNowPlayingTab(state.tab));
