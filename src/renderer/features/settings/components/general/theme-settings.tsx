import isElectron from 'is-electron';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { StylesSettings } from '/@/renderer/features/settings/components/advanced/styles-settings';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useGeneralSettings, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { useSetColorScheme } from '/@/renderer/themes/use-app-theme';
import { ColorInput } from '/@/shared/components/color-input/color-input';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';
import { Stack } from '/@/shared/components/stack/stack';
import { getAppTheme } from '/@/shared/themes/app-theme';

const localSettings = isElectron() ? window.api.localSettings : null;

type Appearance = 'dark' | 'light' | 'system';

/**
 * Appearance, the accent colour, and the CSS escape hatch.
 *
 * The phone offers Light, Dark and System, and so does this: one control over
 * two stored ids, `themeLight` and `themeDark`, rather than a gallery of
 * twenty palettes and a separate switch asking whether to follow the system.
 * The accent is the one colour worth choosing — it is what makes the app the
 * listener's rather than the theme author's — and custom CSS is underneath for
 * anyone who wants the rest.
 */
export const ThemeSettings = memo(() => {
    const { t } = useTranslation();
    const settings = useGeneralSettings();
    const { setSettings } = useSettingsStoreActions();
    const { setColorScheme } = useSetColorScheme();

    const appearance: Appearance = settings.followSystemTheme
        ? 'system'
        : ((getAppTheme(settings.theme).mode ?? 'dark') as Appearance);

    const handleAppearance = (value: string) => {
        const next = value as Appearance;
        const followSystemTheme = next === 'system';
        const theme = next === 'light' ? settings.themeLight : settings.themeDark;

        setSettings({ general: { followSystemTheme, theme } });

        if (!followSystemTheme) {
            setColorScheme(next as 'dark' | 'light');
        }

        localSettings?.themeSet(followSystemTheme ? 'system' : (next as 'dark' | 'light'));
    };

    const themeOptions: SettingOption[] = [
        {
            control: (
                <SegmentedControl
                    aria-label={t('setting.appearance')}
                    data={[
                        { label: t('setting.appearance_optionSystem'), value: 'system' },
                        { label: t('setting.appearance_optionLight'), value: 'light' },
                        { label: t('setting.appearance_optionDark'), value: 'dark' },
                    ]}
                    onChange={handleAppearance}
                    value={appearance}
                />
            ),
            description: t('setting.appearance', { context: 'description' }),
            title: t('setting.appearance'),
        },
        {
            control: (
                <Stack align="center">
                    <ColorInput
                        defaultValue={settings.accent}
                        format="rgb"
                        onChangeEnd={(e) => setSettings({ general: { accent: e } })}
                        swatches={[
                            'rgb(165, 147, 255)',
                            'rgb(53, 116, 252)',
                            'rgb(240, 170, 22)',
                            'rgb(29, 185, 84)',
                            'rgb(214, 81, 63)',
                        ]}
                        swatchesPerRow={5}
                        withEyeDropper={false}
                    />
                </Stack>
            ),
            description: t('setting.accentColor', { context: 'description' }),
            title: t('setting.accentColor'),
        },
    ];

    return (
        <SettingsSection
            extra={<StylesSettings />}
            options={themeOptions}
            title={t('page.setting.theme')}
        />
    );
});
