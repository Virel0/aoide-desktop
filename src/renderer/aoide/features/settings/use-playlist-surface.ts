import type { AoidePlaylistSurface } from '/@/renderer/aoide/features/settings/playlist-surface';

import { shallow } from 'zustand/shallow';

import { useSettingsStore } from '/@/renderer/store/settings.store';

/**
 * The preference as a hook. Kept apart from `playlist-surface.ts` so that file
 * stays importable without the store — the store imports it for the schema and
 * the default, and a module that imported the store back would be a cycle.
 */
export const useAoidePlaylistSurface = (): AoidePlaylistSurface =>
    useSettingsStore((state) => state.general.aoidePlaylistSurface, shallow);
