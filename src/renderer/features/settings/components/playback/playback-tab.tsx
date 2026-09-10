import isElectron from 'is-electron';
import { lazy, memo, Suspense, useMemo } from 'react';
import { shallow } from 'zustand/shallow';

import { CrossfadeSettings } from '/@/renderer/aoide/features/settings/crossfade-settings';
import { AudioSettings } from '/@/renderer/features/settings/components/playback/audio-settings';
import { AutoDJSettings } from '/@/renderer/features/settings/components/playback/auto-dj-settings';
import { EqSettings } from '/@/renderer/features/settings/components/playback/eq-settings';
import { PlayerFilterSettings } from '/@/renderer/features/settings/components/playback/player-filter-settings';
import { TranscodeSettings } from '/@/renderer/features/settings/components/playback/transcode-settings';
import { useSettingsStore } from '/@/renderer/store';
import { Divider } from '/@/shared/components/divider/divider';
import { Stack } from '/@/shared/components/stack/stack';
import { PlayerType } from '/@/shared/types/types';

const MpvSettings = lazy(() =>
    import('/@/renderer/features/settings/components/playback/mpv-settings').then((module) => {
        return { default: module.MpvSettings };
    }),
);

export const PlaybackTab = memo(() => {
    const { audioType, useWebAudio } = useSettingsStore(
        (state) => ({
            audioType: state.playback.type,
            useWebAudio: state.playback.webAudio,
        }),
        shallow,
    );

    const hasFancyAudio = useMemo(() => {
        return (
            (isElectron() && audioType === PlayerType.LOCAL) ||
            (useWebAudio && 'AudioContext' in window)
        );
    }, [audioType, useWebAudio]);

    return (
        <Stack gap="md">
            <AudioSettings />
            <Suspense fallback={<></>}>{hasFancyAudio && <MpvSettings />}</Suspense>
            <EqSettings />
            <Divider />
            <TranscodeSettings />
            <Divider />
            <PlayerFilterSettings />
            <Divider />
            {/* Aoide's own, kept in a file of its own so an upstream merge does
                not have to reconcile it. Beside Auto DJ: one decides how a song
                becomes the next, the other that there is a next one. */}
            <CrossfadeSettings />
            <Divider />
            <AutoDJSettings />
        </Stack>
    );
});
