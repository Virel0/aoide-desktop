import isElectron from 'is-electron';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useHotkeySettings, useSettingsStoreActions } from '/@/renderer/store';
import { Switch } from '/@/shared/components/switch/switch';

const localSettings = isElectron() ? window.api.localSettings : null;

/**
 * Whether Play/Pause and the skip keys reach the app when it is not focused.
 *
 * All that is left of a tab that listed forty-two rebindable actions. The keys
 * on a keyboard that say what they do are the ones anybody presses; the rest
 * keep their defaults, which is what they had.
 */
export const MediaKeysSettings = memo(() => {
    const { t } = useTranslation();
    const settings = useHotkeySettings();
    const { setSettings } = useSettingsStoreActions();

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    checked={settings.globalMediaHotkeys}
                    disabled={!isElectron()}
                    onChange={(e) => {
                        localSettings!.set('global_media_hotkeys', e.currentTarget.checked);
                        setSettings({
                            hotkeys: {
                                globalMediaHotkeys: e.currentTarget.checked,
                            },
                        });

                        if (e.currentTarget.checked) {
                            localSettings!.enableMediaKeys();
                        } else {
                            localSettings!.disableMediaKeys();
                        }
                    }}
                />
            ),
            description: t('setting.globalMediaHotkeys', {
                context: 'description',
            }),
            isHidden: !isElectron(),
            title: t('setting.globalMediaHotkeys'),
        },
    ];

    return <SettingsSection options={options} />;
});
