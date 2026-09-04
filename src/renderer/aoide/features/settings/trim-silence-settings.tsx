import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAoideTrimSilenceEnabled } from '/@/renderer/aoide/features/playback/use-trim-silence';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useSettingsStoreActions } from '/@/renderer/store';
import { Switch } from '/@/shared/components/switch/switch';
import { Text } from '/@/shared/components/text/text';

/**
 * Whether the silence inside recordings is skipped.
 *
 * Its own section, mounted from the general tab the way the other Aoide
 * ones are. The footer says where the numbers come from, because a switch
 * that is on and a track that still opens on two seconds of nothing would
 * otherwise look like a switch that does nothing.
 */
export const TrimSilenceSettings = memo(() => {
    const { t } = useTranslation();
    const enabled = useAoideTrimSilenceEnabled();
    const { setSettings } = useSettingsStoreActions();

    if (!isAoideAvailable()) return null;

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    aria-label={t('aoide.settings.trimSilence')}
                    checked={enabled}
                    onChange={(e) => {
                        setSettings({ general: { aoideTrimSilence: e.currentTarget.checked } });
                    }}
                />
            ),
            description: t('aoide.settings.trimSilence', { context: 'description' }),
            title: t('aoide.settings.trimSilence'),
        },
    ];

    return (
        <SettingsSection
            extra={
                <Text isMuted size="sm">
                    {t('aoide.settings.trimSilence', { context: 'footer' })}
                </Text>
            }
            options={options}
        />
    );
});
