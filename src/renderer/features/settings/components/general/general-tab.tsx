import { memo, useMemo } from 'react';
import { Fragment } from 'react/jsx-runtime';

import { HiddenFromMixesSettings } from '/@/renderer/aoide/features/settings/hidden-from-mixes-settings';
import { LoudnessNormalisationSettings } from '/@/renderer/aoide/features/settings/loudness-normalisation-settings';
import { NowPlayingColumnSettings } from '/@/renderer/aoide/features/settings/now-playing-column-settings';
import { PlaylistSurfaceSettings } from '/@/renderer/aoide/features/settings/playlist-surface-settings';
import { SmartSearchSettings } from '/@/renderer/aoide/features/settings/smart-search-settings';
import { TrimSilenceSettings } from '/@/renderer/aoide/features/settings/trim-silence-settings';
import { ApplicationSettings } from '/@/renderer/features/settings/components/general/application-settings';
import { ControlSettings } from '/@/renderer/features/settings/components/general/control-settings';
import { ExternalLinksSettings } from '/@/renderer/features/settings/components/general/external-links-settings';
import { LyricSettings } from '/@/renderer/features/settings/components/general/lyric-settings';
import { SidebarSettings } from '/@/renderer/features/settings/components/general/sidebar-settings';
import { ThemeSettings } from '/@/renderer/features/settings/components/general/theme-settings';
import { Divider } from '/@/shared/components/divider/divider';
import { Stack } from '/@/shared/components/stack/stack';

export const GeneralTab = memo(() => {
    const sections = useMemo(() => {
        return [
            { component: ThemeSettings, key: 'theme' },
            { component: ApplicationSettings, key: 'application' },
            { component: ExternalLinksSettings, key: 'externalLinks' },
            { component: ControlSettings, key: 'control' },
            { component: SidebarSettings, key: 'sidebar' },
            { component: LyricSettings, key: 'lyrics' },
            // Aoide's own, kept in a file of its own so an upstream merge does not
            // have to reconcile it.
            { component: SmartSearchSettings, key: 'aoideSmartSearch' },
            { component: PlaylistSurfaceSettings, key: 'aoidePlaylistSurface' },
            { component: NowPlayingColumnSettings, key: 'aoideNowPlayingColumn' },
            { component: HiddenFromMixesSettings, key: 'aoideHiddenFromMixes' },
            { component: TrimSilenceSettings, key: 'aoideTrimSilence' },
            { component: LoudnessNormalisationSettings, key: 'aoideLoudnessNormalisation' },
        ];
    }, []);

    return (
        <Stack gap="md">
            {sections.map(({ component: Section, key }, index) => (
                <Fragment key={key}>
                    <Section />
                    {index < sections.length - 1 && <Divider />}
                </Fragment>
            ))}
        </Stack>
    );
});
