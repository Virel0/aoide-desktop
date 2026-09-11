import { shallow } from 'zustand/shallow';

import { useSettingsStore } from '/@/renderer/store/settings.store';

/**
 * The two preferences as hooks.
 *
 * Kept apart from `crossfade.ts` so that file stays importable without the store
 * — the store imports it for the schemas and the defaults, and a module that
 * imported the store back would be a cycle.
 */
export const useAoideCrossfadeEnabled = (): boolean =>
    useSettingsStore((state) => state.general.aoideCrossfade, shallow);

export const useAoideAlbumLockEnabled = (): boolean =>
    useSettingsStore((state) => state.general.aoideAlbumLock, shallow);

export const useAoideExactJoinsEnabled = (): boolean =>
    useSettingsStore((state) => state.general.aoideExactJoins, shallow);
