import isElectron from 'is-electron';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useLyricsSettings, useSettingsStoreActions } from '/@/renderer/store';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { Switch } from '/@/shared/components/switch/switch';

/**
 * Whether lyrics are looked up at all, and how far ahead of the music they run.
 *
 * The phone's two rows. Everything else that used to be here — which provider
 * to ask, local before remote, furigana, romaji, and a machine-translation
 * panel with its own API key — was either a decision the app can make on its
 * own or a feature nothing on this side ever read.
 */
export const LyricSettings = memo(() => {
    const { t } = useTranslation();
    const settings = useLyricsSettings();
    const { setSettings } = useSettingsStoreActions();

    const lyricOptions: SettingOption[] = [
        {
            control: (
                <Switch
                    aria-label={t('setting.lyricFetch')}
                    defaultChecked={settings.fetch}
                    onChange={(e) =>
                        setSettings({ lyrics: { ...settings, fetch: e.currentTarget.checked } })
                    }
                />
            ),
            description: t('setting.lyricFetch', { context: 'description' }),
            isHidden: !isElectron(),
            title: t('setting.lyricFetch'),
        },
        {
            control: (
                <NumberInput
                    defaultValue={settings.delayMs}
                    onBlur={(e) =>
                        setSettings({
                            lyrics: { ...settings, delayMs: Number(e.currentTarget.value) },
                        })
                    }
                    step={10}
                    width={100}
                />
            ),
            description: t('setting.lyricOffset', { context: 'description' }),
            title: t('setting.lyricOffset'),
        },
    ];

    return <SettingsSection options={lyricOptions} title={t('page.setting.lyrics')} />;
});
