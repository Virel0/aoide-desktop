import { memo } from 'react';
import { Fragment } from 'react/jsx-runtime';

import { HiddenFromMixesSettings } from '/@/renderer/aoide/features/settings/hidden-from-mixes-settings';
import { NowPlayingColumnSettings } from '/@/renderer/aoide/features/settings/now-playing-column-settings';
import { PlaylistSurfaceSettings } from '/@/renderer/aoide/features/settings/playlist-surface-settings';
import { SmartSearchSettings } from '/@/renderer/aoide/features/settings/smart-search-settings';
import { LyricSettings } from '/@/renderer/features/settings/components/general/lyric-settings';
import { ThemeSettings } from '/@/renderer/features/settings/components/general/theme-settings';
import { Divider } from '/@/shared/components/divider/divider';
import { Stack } from '/@/shared/components/stack/stack';

const sections = [
    { component: ThemeSettings, key: 'theme' },
    { component: PlaylistSurfaceSettings, key: 'aoidePlaylistSurface' },
    { component: NowPlayingColumnSettings, key: 'aoideNowPlayingColumn' },
    { component: HiddenFromMixesSettings, key: 'aoideHiddenFromMixes' },
    { component: LyricSettings, key: 'lyrics' },
    { component: SmartSearchSettings, key: 'aoideSmartSearch' },
];

export const GeneralTab = memo(() => {
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
