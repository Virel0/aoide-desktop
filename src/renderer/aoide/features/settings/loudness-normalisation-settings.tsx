import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAoideLoudnessNormalisationEnabled } from '/@/renderer/aoide/features/playback/use-loudness-normalisation';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useSettingsStoreActions } from '/@/renderer/store';
import { Switch } from '/@/shared/components/switch/switch';
import { Text } from '/@/shared/components/text/text';

/**
 * Whether tracks are brought to a common loudness.
 *
 * Its own section, mounted from the general tab the way the other Aoide ones
 * are. The footer says where the numbers come from and that a file with its
 * own ReplayGain is left to those tags, because a switch that is on and a
 * remaster that is still louder than everything else would otherwise look like
 * a switch that does nothing.
 */
export const LoudnessNormalisationSettings = memo(() => {
    const { t } = useTranslation();
    const enabled = useAoideLoudnessNormalisationEnabled();
    const { setSettings } = useSettingsStoreActions();

    if (!isAoideAvailable()) return null;

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    aria-label={t('aoide.settings.loudnessNormalisation')}
                    checked={enabled}
                    onChange={(e) => {
                        setSettings({
                            general: { aoideLoudnessNormalisation: e.currentTarget.checked },
                        });
                    }}
                />
            ),
            description: t('aoide.settings.loudnessNormalisation', { context: 'description' }),
            title: t('aoide.settings.loudnessNormalisation'),
        },
    ];

    return (
        <SettingsSection
            extra={
                <Text isMuted size="sm">
                    {t('aoide.settings.loudnessNormalisation', { context: 'footer' })}
                </Text>
            }
            options={options}
        />
    );
});
