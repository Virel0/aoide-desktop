import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
    useAoideAlbumLockEnabled,
    useAoideAutomixEnabled,
} from '/@/renderer/aoide/features/playback/use-automix';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useSettingsStoreActions } from '/@/renderer/store';
import { Switch } from '/@/shared/components/switch/switch';
import { Text } from '/@/shared/components/text/text';

/**
 * Whether one song is faded into the next, and whether records are exempt.
 *
 * Beside Auto DJ, because they are the two halves of the same job: AutoMix
 * decides how one song becomes the next, Auto DJ decides that there is a next
 * one. The footer says that mpv cannot do this and what it does instead —
 * a switch that is on and a player that still cuts between every track would
 * otherwise look like a switch that does nothing.
 */
export const AutomixSettings = memo(() => {
    const { t } = useTranslation();
    const automix = useAoideAutomixEnabled();
    const albumLock = useAoideAlbumLockEnabled();
    const { setSettings } = useSettingsStoreActions();

    if (!isAoideAvailable()) return null;

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    aria-label={t('aoide.settings.automix')}
                    checked={automix}
                    onChange={(e) => {
                        setSettings({ general: { aoideAutomix: e.currentTarget.checked } });
                    }}
                />
            ),
            description: t('aoide.settings.automix', { context: 'description' }),
            title: t('aoide.settings.automix'),
        },
        {
            control: (
                <Switch
                    aria-label={t('aoide.settings.albumLock')}
                    checked={albumLock}
                    onChange={(e) => {
                        setSettings({ general: { aoideAlbumLock: e.currentTarget.checked } });
                    }}
                />
            ),
            description: t('aoide.settings.albumLock', { context: 'description' }),
            title: t('aoide.settings.albumLock'),
        },
    ];

    return (
        <SettingsSection
            extra={
                <Text isMuted size="sm">
                    {t('aoide.settings.automix', { context: 'footer' })}
                </Text>
            }
            options={options}
        />
    );
});
