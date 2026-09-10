import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
    getDefaultAudioDevice,
    useAudioDevices,
} from '/@/renderer/features/settings/components/playback/audio-settings';
import {
    ListConfigBooleanControl,
    ListConfigTable,
} from '/@/renderer/features/shared/components/list-config-menu';
import { usePlayerActions, usePlayerProperties, usePlayerStatus } from '/@/renderer/store';
import {
    useCombinedLyricsAndVisualizer,
    usePlaybackSettings,
    useSettingsStoreActions,
    useShowLyricsInSidebar,
    useShowQueueInSidebar,
    useShowVisualizerInSidebar,
} from '/@/renderer/store/settings.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Paper } from '/@/shared/components/paper/paper';
import { Popover } from '/@/shared/components/popover/popover';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';
import { Select } from '/@/shared/components/select/select';
import { Slider } from '/@/shared/components/slider/slider';
import { Stack } from '/@/shared/components/stack/stack';
import { CrossfadeStyle, PlayerStatus, PlayerStyle } from '/@/shared/types/types';

export const PlayerConfig = () => {
    const { t } = useTranslation();
    const showLyricsInSidebar = useShowLyricsInSidebar();
    const showQueueInSidebar = useShowQueueInSidebar();
    const showVisualizerInSidebar = useShowVisualizerInSidebar();
    const combinedLyricsAndVisualizer = useCombinedLyricsAndVisualizer();
    const { transitionType } = usePlayerProperties();

    const { setSettings } = useSettingsStoreActions();

    const audioOptions = useMemo(
        () => [
            {
                component: <AudioDeviceConfig />,
                id: 'audioDevice',
                label: t('setting.audioDevice'),
            },
        ],
        [t],
    );

    const transitionOptions = useMemo(
        () => [
            {
                component: <TransitionTypeConfig />,
                id: 'transitionType',
                label: t('setting.playbackStyle'),
            },
            {
                component: <CrossfadeStyleConfig />,
                id: 'crossfadeStyle',
                isHidden: transitionType !== PlayerStyle.CROSSFADE,
                label: t('setting.crossfadeStyle'),
            },
            {
                component: <CrossfadeDurationConfig />,
                id: 'crossfadeDuration',
                isHidden: transitionType !== PlayerStyle.CROSSFADE,
                label: t('setting.crossfadeDuration'),
            },
        ],
        [t, transitionType],
    );

    const sidebarOptions = useMemo(
        () => [
            {
                component: (
                    <ListConfigBooleanControl
                        onChange={(value) => {
                            setSettings({
                                general: {
                                    showQueueInSidebar: value,
                                },
                            });
                        }}
                        value={showQueueInSidebar}
                    />
                ),
                id: 'showQueueInSidebar',
                label: t('setting.showQueueInSidebar'),
            },
            {
                component: (
                    <ListConfigBooleanControl
                        onChange={(value) => {
                            setSettings({
                                general: {
                                    showLyricsInSidebar: value,
                                },
                            });
                        }}
                        value={showLyricsInSidebar}
                    />
                ),
                id: 'showLyricsInSidebar',
                label: t('setting.showLyricsInSidebar'),
            },
            {
                component: (
                    <ListConfigBooleanControl
                        onChange={(value) => {
                            setSettings({
                                general: {
                                    showVisualizerInSidebar: value,
                                },
                            });
                        }}
                        value={showVisualizerInSidebar}
                    />
                ),
                id: 'showVisualizerInSidebar',
                label: t('setting.showVisualizerInSidebar'),
            },
            {
                component: (
                    <ListConfigBooleanControl
                        onChange={(value) => {
                            setSettings({
                                general: {
                                    combinedLyricsAndVisualizer: value,
                                },
                            });
                        }}
                        value={combinedLyricsAndVisualizer}
                    />
                ),
                id: 'combinedLyricsAndVisualizer',
                label: t('setting.combinedLyricsAndVisualizer'),
            },
        ],
        [
            combinedLyricsAndVisualizer,
            setSettings,
            showLyricsInSidebar,
            showQueueInSidebar,
            showVisualizerInSidebar,
            t,
        ],
    );

    return (
        <Popover position="top" withArrow>
            <Popover.Target>
                <ActionIcon
                    icon="mediaSettings"
                    iconProps={{
                        size: 'lg',
                    }}
                    size="sm"
                    stopsPropagation
                    tooltip={{
                        label: t('common.setting', { count: 2 }),
                        openDelay: 0,
                    }}
                    variant="subtle"
                />
            </Popover.Target>
            <Popover.Dropdown maw={720} miw={540} onClick={(e) => e.stopPropagation()} p="sm">
                <Stack gap="sm">
                    <Paper p="md" radius="md">
                        <ListConfigTable options={audioOptions} />
                    </Paper>
                    <Paper p="md" radius="md">
                        <ListConfigTable options={transitionOptions} />
                    </Paper>
                    <Paper p="md" radius="md">
                        <ListConfigTable options={sidebarOptions} />
                    </Paper>
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};

const AudioDeviceConfig = () => {
    const status = usePlayerStatus();
    const playbackSettings = usePlaybackSettings();
    const { setSettings } = useSettingsStoreActions();

    const audioDevices = useAudioDevices();

    return (
        <Select
            comboboxProps={{ withinPortal: false }}
            data={audioDevices}
            disabled={status === PlayerStatus.PLAYING}
            onChange={(e) => {
                setSettings({
                    playback: { ...playbackSettings, audioDeviceId: e },
                });
            }}
            value={playbackSettings.audioDeviceId ?? getDefaultAudioDevice(audioDevices)}
            variant="filled"
            width="100%"
        />
    );
};

const TransitionTypeConfig = () => {
    const { t } = useTranslation();
    const status = usePlayerStatus();
    const { transitionType } = usePlayerProperties();
    const { setTransitionType } = usePlayerActions();

    return (
        <SegmentedControl
            data={[
                {
                    label: t('setting.playbackStyle', {
                        context: 'optionNormal',
                    }),
                    value: PlayerStyle.GAPLESS,
                },
                {
                    label: t('setting.playbackStyle', {
                        context: 'optionCrossFade',
                    }),
                    value: PlayerStyle.CROSSFADE,
                },
            ]}
            disabled={status === PlayerStatus.PLAYING}
            onChange={(value) => setTransitionType(value as PlayerStyle)}
            size="sm"
            value={transitionType}
            w="100%"
        />
    );
};

const CrossfadeStyleConfig = () => {
    const status = usePlayerStatus();
    const { crossfadeStyle, transitionType } = usePlayerProperties();
    const { setCrossfadeStyle } = usePlayerActions();

    return (
        <Select
            comboboxProps={{ withinPortal: false }}
            data={[
                { label: 'Linear', value: CrossfadeStyle.LINEAR },
                { label: 'Equal Power', value: CrossfadeStyle.EQUAL_POWER },
                { label: 'S-Curve', value: CrossfadeStyle.S_CURVE },
                { label: 'Exponential', value: CrossfadeStyle.EXPONENTIAL },
            ]}
            defaultValue={crossfadeStyle}
            disabled={transitionType !== PlayerStyle.CROSSFADE || status === PlayerStatus.PLAYING}
            onChange={(e) => {
                if (e) {
                    setCrossfadeStyle(e as CrossfadeStyle);
                }
            }}
            variant="filled"
            width="100%"
        />
    );
};

const CrossfadeDurationConfig = () => {
    const status = usePlayerStatus();
    const { crossfadeDuration, transitionType } = usePlayerProperties();
    const { setCrossfadeDuration } = usePlayerActions();

    return (
        <Slider
            defaultValue={crossfadeDuration}
            disabled={transitionType !== PlayerStyle.CROSSFADE || status === PlayerStatus.PLAYING}
            marks={[
                { label: '3', value: 3 },
                { label: '6', value: 6 },
                { label: '9', value: 9 },
                { label: '12', value: 12 },
                { label: '15', value: 15 },
            ]}
            max={15}
            min={3}
            onChangeEnd={setCrossfadeDuration}
            styles={{
                root: {},
            }}
            w="100%"
        />
    );
};
