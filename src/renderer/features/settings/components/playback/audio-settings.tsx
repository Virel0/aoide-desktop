import { t } from 'i18next';
import isElectron from 'is-electron';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { usePlaybackSettings, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { Select } from '/@/shared/components/select/select';
import { toast } from '/@/shared/components/toast/toast';

const getAudioDevices = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return (devices || []).filter((dev: MediaDeviceInfo) => dev.kind === 'audiooutput');
};

export type AudioDeviceOption = { label: string; value: string };

export const getDefaultAudioDevice = (devices: AudioDeviceOption[]): null | string =>
    devices.find((d) => d.value === 'default')?.value ?? devices[0]?.value ?? null;

export const useAudioDevices = () => {
    const [audioDevices, setAudioDevices] = useState<AudioDeviceOption[]>([]);

    useEffect(() => {
        if (!isElectron()) {
            return;
        }

        getAudioDevices()
            .then((dev) => {
                const uniqueDevices = dev.filter(
                    (d, index, self) => index === self.findIndex((t) => t.deviceId === d.deviceId),
                );
                setAudioDevices(uniqueDevices.map((d) => ({ label: d.label, value: d.deviceId })));
            })
            .catch(() =>
                toast.error({
                    message: t('error.audioDeviceFetchError'),
                }),
            );
    }, []);

    return audioDevices;
};

export const AudioSettings = memo(() => {
    const { t } = useTranslation();
    const settings = usePlaybackSettings();
    const { setSettings } = useSettingsStoreActions();

    const audioDevices = useAudioDevices();

    const audioOptions: SettingOption[] = [
        {
            control: (
                <Select
                    clearable
                    data={audioDevices}
                    disabled={!isElectron()}
                    onChange={(e) => setSettings({ playback: { audioDeviceId: e } })}
                    value={settings.audioDeviceId ?? getDefaultAudioDevice(audioDevices)}
                />
            ),
            description: t('setting.audioDevice', { context: 'description' }),
            isHidden: !isElectron(),
            title: t('setting.audioDevice'),
        },
    ];

    return <SettingsSection options={audioOptions} title={t('page.setting.audio')} />;
});
