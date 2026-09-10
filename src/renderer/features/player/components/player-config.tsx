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
import { usePlayerStatus } from '/@/renderer/store';
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
import { Select } from '/@/shared/components/select/select';
import { Stack } from '/@/shared/components/stack/stack';
import { PlayerStatus } from '/@/shared/types/types';

export const PlayerConfig = () => {
    const { t } = useTranslation();
    const showLyricsInSidebar = useShowLyricsInSidebar();
    const showQueueInSidebar = useShowQueueInSidebar();
    const showVisualizerInSidebar = useShowVisualizerInSidebar();
    const combinedLyricsAndVisualizer = useCombinedLyricsAndVisualizer();
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
