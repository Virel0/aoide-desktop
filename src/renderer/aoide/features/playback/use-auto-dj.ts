import { shallow } from 'zustand/shallow';

import { useSettingsStore } from '/@/renderer/store/settings.store';

/**
 * The preference as a hook, apart from `auto-dj.ts` so that file stays
 * importable without the store.
 */
export const useAoideAutoDjEnabled = (): boolean =>
    useSettingsStore((state) => state.general.aoideAutoDj, shallow);
