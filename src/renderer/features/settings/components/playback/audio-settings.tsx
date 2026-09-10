import { t } from 'i18next';
import isElectron from 'is-electron';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import {
    SettingsState,
    usePlaybackSettings,
    useSettingsStoreActions,
} from '/@/renderer/store/settings.store';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { Select } from '/@/shared/components/select/select';
import { Switch } from '/@/shared/components/switch/switch';
import { Text } from '/@/shared/components/text/text';
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

    // The sample rate and ReplayGain act on the Web Audio graph and do nothing
    // without it, which is the gate the MPV panel used to apply to them from
    // one level up before they moved here.
    const hasAudioGraph = settings.webAudio && 'AudioContext' in window;

    const setAudioProperty = (
        setting: keyof SettingsState['playback']['audioProperties'],
        value: unknown,
    ) => {
        setSettings({
            playback: {
                audioProperties: {
                    [setting]: value,
                },
            },
        });
    };

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
        {
            control: (
                <NumberInput
                    defaultValue={settings.audioProperties.audioSampleRateHz || undefined}
                    max={192000}
                    min={0}
                    onBlur={(e) => {
                        setAudioProperty('audioSampleRateHz', Number(e.currentTarget.value));
                    }}
                    placeholder="48000"
                    rightSection={<Text size="xs">Hz</Text>}
                    width={100}
                />
            ),
            description: t('setting.sampleRate', { context: 'description' }),
            isHidden: !hasAudioGraph,
            // The AudioContext is built once, at startup, with this rate.
            note: t('common.restartRequired'),
            title: t('setting.sampleRate'),
        },
        {
            control: (
                <Switch
                    defaultChecked={settings.webAudio}
                    onChange={(e) => {
                        setSettings({
                            playback: { webAudio: e.currentTarget.checked },
                        });
                    }}
                />
            ),
            description: t('setting.webAudio', { context: 'description' }),
            note: t('common.restartRequired'),
            title: t('setting.webAudio'),
        },
        {
            control: (
                <Switch
                    defaultChecked={settings.audioFadeOnStatusChange}
                    onChange={(e) => {
                        setSettings({
                            playback: { audioFadeOnStatusChange: e.currentTarget.checked },
                        });
                    }}
                />
            ),
            description: t('setting.audioFadeOnStatusChange', { context: 'description' }),
            title: t('setting.audioFadeOnStatusChange'),
        },
    ];

    // Read as each slot's source is wired up, so a change here lands on the
    // next track rather than needing a restart.
    const replayGainOptions: SettingOption[] = [
        {
            control: (
                <Select
                    data={[
                        {
                            label: t('setting.replayGainMode', { context: 'optionNone' }),
                            value: 'no',
                        },
                        {
                            label: t('setting.replayGainMode', { context: 'optionTrack' }),
                            value: 'track',
                        },
                        {
                            label: t('setting.replayGainMode', { context: 'optionAlbum' }),
                            value: 'album',
                        },
                    ]}
                    defaultValue={settings.audioProperties.replayGainMode}
                    onChange={(e) => setAudioProperty('replayGainMode', e)}
                />
            ),
            description: t('setting.replayGainMode', {
                context: 'description',

                ReplayGain: 'ReplayGain',
            }),
            title: t('setting.replayGainMode', { ReplayGain: 'ReplayGain' }),
        },
        {
            control: (
                <NumberInput
                    defaultValue={settings.audioProperties.replayGainPreampDB}
                    onChange={(e) => setAudioProperty('replayGainPreampDB', Number(e) || 0)}
                    width={75}
                />
            ),
            description: t('setting.replayGainMode', {
                context: 'description',

                ReplayGain: 'ReplayGain',
            }),
            title: t('setting.replayGainPreamp', { ReplayGain: 'ReplayGain' }),
        },
        {
            control: (
                <Switch
                    defaultChecked={settings.audioProperties.replayGainClip}
                    onChange={(e) => setAudioProperty('replayGainClip', e.currentTarget.checked)}
                />
            ),
            description: t('setting.replayGainClipping', {
                context: 'description',

                ReplayGain: 'ReplayGain',
            }),
            title: t('setting.replayGainClipping', { ReplayGain: 'ReplayGain' }),
        },
        {
            control: (
                <NumberInput
                    defaultValue={settings.audioProperties.replayGainFallbackDB}
                    onBlur={(e) =>
                        setAudioProperty('replayGainFallbackDB', Number(e.currentTarget.value))
                    }
                    width={75}
                />
            ),
            description: t('setting.replayGainFallback', { ReplayGain: 'ReplayGain' }),
            title: t('setting.replayGainFallback', { ReplayGain: 'ReplayGain' }),
        },
    ];

    return (
        <>
            <SettingsSection options={audioOptions} title={t('page.setting.audio')} />
            {hasAudioGraph && <SettingsSection options={replayGainOptions} />}
        </>
    );
});
