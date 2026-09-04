import { useEffect, useState } from 'react';
import { shallow } from 'zustand/shallow';

import {
    COLUMN_MEDIA_QUERY,
    showsNowPlayingColumn,
} from '/@/renderer/aoide/features/now-playing/now-playing-column';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { useSettingsStore } from '/@/renderer/store/settings.store';

/**
 * The preference as a hook. Kept apart from `now-playing-column.ts` so that
 * file stays importable without the store — the store imports it for the
 * schema and the default, and a module that imported the store back would be
 * a cycle.
 */
export const useAoideNowPlayingColumnEnabled = (): boolean =>
    useSettingsStore((state) => state.general.aoideNowPlayingColumn, shallow);

/**
 * Whether the column is on screen right now: enabled, and the window wide
 * enough to hold it beside the page.
 *
 * The width is read through the same media query the CSS would use, so a
 * window dragged narrower collapses the column and gives the page its width
 * back, and dragged wider brings it back — with no layout code of its own.
 * The web and remote builds have no Aoide half and keep Feishin's bar.
 */
export const useAoideNowPlayingColumn = (): boolean => {
    const enabled = useAoideNowPlayingColumnEnabled();
    const [windowIsWide, setWindowIsWide] = useState(
        () => window.matchMedia(COLUMN_MEDIA_QUERY).matches,
    );

    useEffect(() => {
        const query = window.matchMedia(COLUMN_MEDIA_QUERY);
        const onChange = (event: MediaQueryListEvent) => setWindowIsWide(event.matches);

        setWindowIsWide(query.matches);
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, []);

    return isAoideAvailable() && showsNowPlayingColumn(enabled, windowIsWide);
};
