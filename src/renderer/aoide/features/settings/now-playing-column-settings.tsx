import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAoideNowPlayingColumnEnabled } from '/@/renderer/aoide/features/now-playing/use-now-playing-column';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useSettingsStoreActions } from '/@/renderer/store';
import { Switch } from '/@/shared/components/switch/switch';

/**
 * Whether Now Playing is a column beside the page or Feishin's bottom bar.
 *
 * Its own section, mounted from the general tab the way the playlist-surface
 * one is, so an upstream merge of Feishin's settings never has to reconcile
 * it.
 */
export const NowPlayingColumnSettings = memo(() => {
    const { t } = useTranslation();
    const enabled = useAoideNowPlayingColumnEnabled();
    const { setSettings } = useSettingsStoreActions();

    // The web and remote builds keep Feishin's bar; a switch for a column
    // that cannot appear is a switch that does nothing.
    if (!isAoideAvailable()) return null;

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    aria-label={t('aoide.settings.nowPlayingColumn')}
                    checked={enabled}
                    onChange={(e) => {
                        setSettings({
                            general: { aoideNowPlayingColumn: e.currentTarget.checked },
                        });
                    }}
                />
            ),
            description: t('aoide.settings.nowPlayingColumn', { context: 'description' }),
            title: t('aoide.settings.nowPlayingColumn'),
        },
    ];

    return <SettingsSection options={options} />;
});
