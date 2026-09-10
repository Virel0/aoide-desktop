import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
    useAoideAlbumLockEnabled,
    useAoideCrossfadeEnabled,
} from '/@/renderer/aoide/features/playback/use-crossfade';
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
 * Beside Auto DJ, because they are the two halves of the same job: Crossfade
 * decides how one song becomes the next, Auto DJ decides that there is a next
 * one. The footer says what the fade costs, because a fade that starts the
 * next song early is a fade that shortens the one before it, and someone who
 * turns this on without knowing that will hear it as tracks being cut off.
 */
export const CrossfadeSettings = memo(() => {
    const { t } = useTranslation();
    const crossfade = useAoideCrossfadeEnabled();
    const albumLock = useAoideAlbumLockEnabled();
    const { setSettings } = useSettingsStoreActions();

    if (!isAoideAvailable()) return null;

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    aria-label={t('aoide.settings.crossfade')}
                    checked={crossfade}
                    onChange={(e) => {
                        setSettings({ general: { aoideCrossfade: e.currentTarget.checked } });
                    }}
                />
            ),
            description: t('aoide.settings.crossfade', { context: 'description' }),
            title: t('aoide.settings.crossfade'),
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
                    {t('aoide.settings.crossfade', { context: 'footer' })}
                </Text>
            }
            options={options}
        />
    );
});
