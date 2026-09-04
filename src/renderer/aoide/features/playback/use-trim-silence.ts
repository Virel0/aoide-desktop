import { shallow } from 'zustand/shallow';

import { useSettingsStore } from '/@/renderer/store/settings.store';

/**
 * The preference as a hook, and as a plain read for code outside React.
 *
 * Kept apart from `trim-silence.ts` so that file stays importable without
 * the store — the store imports it for the schema and the default, and a
 * module that imported the store back would be a cycle.
 */
export const useAoideTrimSilenceEnabled = (): boolean =>
    useSettingsStore((state) => state.general.aoideTrimSilence, shallow);

export const isTrimSilenceEnabled = (): boolean =>
    useSettingsStore.getState().general.aoideTrimSilence;
