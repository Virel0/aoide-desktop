import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAoideAutoDjEnabled } from '/@/renderer/aoide/features/playback/use-auto-dj';
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
 * Whether one song is faded into the next, whether records are exempt, and
 * whether a pair the server has gridded is mixed rather than faded.
 *
 * Beside Infinity, because they are the two halves of the same job: these
 * decide how one song becomes the next, Infinity decides that there is a next
 * one. Auto DJ sits under Crossfade because it is the same decision made with
 * more knowledge — a beat-matched, bar-aligned, bass-swapped hand-over where
 * the server has measured both records, and a crossfade everywhere else. The
 * footer says what the fade costs, because a fade that starts the next song
 * early is a fade that shortens the one before it, and someone who turns this
 * on without knowing that will hear it as tracks being cut off.
 */
export const CrossfadeSettings = memo(() => {
    const { t } = useTranslation();
    const crossfade = useAoideCrossfadeEnabled();
    const albumLock = useAoideAlbumLockEnabled();
    const autoDj = useAoideAutoDjEnabled();
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
        {
            control: (
                <Switch
                    aria-label={t('aoide.settings.autoDj')}
                    checked={autoDj}
                    onChange={(e) => {
                        setSettings({ general: { aoideAutoDj: e.currentTarget.checked } });
                    }}
                />
            ),
            description: t('aoide.settings.autoDj', { context: 'description' }),
            title: t('aoide.settings.autoDj'),
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
