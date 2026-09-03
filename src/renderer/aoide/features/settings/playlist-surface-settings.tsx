import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
    AoidePlaylistSurface,
    AoidePlaylistSurfaceSchema,
} from '/@/renderer/aoide/features/settings/playlist-surface';
import { useAoidePlaylistSurface } from '/@/renderer/aoide/features/settings/use-playlist-surface';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useSettingsStoreActions } from '/@/renderer/store';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';

/**
 * Which playlists the sidebar shows.
 *
 * Its own section, mounted from the general tab the way the smart-search one
 * is, so an upstream merge of Feishin's sidebar settings never has to
 * reconcile it.
 */
export const PlaylistSurfaceSettings = memo(() => {
    const { t } = useTranslation();
    const surface = useAoidePlaylistSurface();
    const { setSettings } = useSettingsStoreActions();

    // The web and remote builds have no Aoide playlists to show or hide, and a
    // choice between two things where one cannot exist is not a choice.
    if (!isAoideAvailable()) return null;

    const options: SettingOption[] = [
        {
            control: (
                <SegmentedControl
                    data={AoidePlaylistSurfaceSchema.options.map((value) => ({
                        label: t(`aoide.settings.playlistSurface_option_${value}`),
                        value,
                    }))}
                    onChange={(value) => {
                        setSettings({
                            general: { aoidePlaylistSurface: value as AoidePlaylistSurface },
                        });
                    }}
                    value={surface}
                />
            ),
            description: t('aoide.settings.playlistSurface', { context: 'description' }),
            title: t('aoide.settings.playlistSurface'),
        },
    ];

    return <SettingsSection options={options} />;
});
