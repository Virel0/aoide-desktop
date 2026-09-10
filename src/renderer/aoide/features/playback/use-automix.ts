import { shallow } from 'zustand/shallow';

import { useSettingsStore } from '/@/renderer/store/settings.store';

/**
 * The two preferences as hooks.
 *
 * Kept apart from `automix.ts` so that file stays importable without the store
 * — the store imports it for the schemas and the defaults, and a module that
 * imported the store back would be a cycle.
 */
export const useAoideAutomixEnabled = (): boolean =>
    useSettingsStore((state) => state.general.aoideAutomix, shallow);

export const useAoideAlbumLockEnabled = (): boolean =>
    useSettingsStore((state) => state.general.aoideAlbumLock, shallow);
