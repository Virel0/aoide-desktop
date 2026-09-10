import { memo } from 'react';

import { CrossfadeSettings } from '/@/renderer/aoide/features/settings/crossfade-settings';
import { AudioSettings } from '/@/renderer/features/settings/components/playback/audio-settings';
import { AutoDJSettings } from '/@/renderer/features/settings/components/playback/auto-dj-settings';
import { EqSettings } from '/@/renderer/features/settings/components/playback/eq-settings';
import { TranscodeSettings } from '/@/renderer/features/settings/components/playback/transcode-settings';
import { Divider } from '/@/shared/components/divider/divider';
import { Stack } from '/@/shared/components/stack/stack';

export const PlaybackTab = memo(() => {
    return (
        <Stack gap="md">
            <AudioSettings />
            <EqSettings />
            <Divider />
            <TranscodeSettings />
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
