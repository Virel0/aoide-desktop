import { memo } from 'react';

import { CrossfadeSettings } from '/@/renderer/aoide/features/settings/crossfade-settings';
import { LoudnessNormalisationSettings } from '/@/renderer/aoide/features/settings/loudness-normalisation-settings';
import { TrimSilenceSettings } from '/@/renderer/aoide/features/settings/trim-silence-settings';
import { AudioSettings } from '/@/renderer/features/settings/components/playback/audio-settings';
import { AutoDJSettings } from '/@/renderer/features/settings/components/playback/auto-dj-settings';
import { EqSettings } from '/@/renderer/features/settings/components/playback/eq-settings';
import { TranscodeSettings } from '/@/renderer/features/settings/components/playback/transcode-settings';
import { Divider } from '/@/shared/components/divider/divider';
import { Stack } from '/@/shared/components/stack/stack';

/**
 * Everything about how the music sounds, in the order a person would ask.
 *
 * Crossfade and its exemption first, because they are what a listener notices;
 * then the two that decide what a track's edges and level are; then the output
 * device, the transcoding and the graph. Trim Silence and Level Volume moved
 * here from the general tab — they are the phone's Gapless section, and they
 * were only ever in General because that is where Aoide's own rows were first
 * bolted on.
 */
export const PlaybackTab = memo(() => {
    return (
        <Stack gap="md">
            <CrossfadeSettings />
            <Divider />
            <AutoDJSettings />
            <Divider />
            <TrimSilenceSettings />
            <Divider />
            <LoudnessNormalisationSettings />
            <Divider />
            <AudioSettings />
            <Divider />
            <TranscodeSettings />
            <Divider />
            <EqSettings />
        </Stack>
    );
});
