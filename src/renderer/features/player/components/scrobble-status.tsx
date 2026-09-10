import formatDuration from 'format-duration';
import { useTranslation } from 'react-i18next';

import {
    invokeScrobbleForceSubmit,
    invokeScrobbleResetListenedState,
} from '/@/renderer/features/player/hooks/use-scrobble';
import { useAppStore, usePlayerTimestamp, useScrobbleDebugSnapshot } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { HoverCard } from '/@/shared/components/hover-card/hover-card';
import { Icon } from '/@/shared/components/icon/icon';
import { Progress } from '/@/shared/components/progress/progress';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { PlaybackSelectors } from '/@/shared/constants/playback-selectors';

const scrobbleProgressProps = {
    'aria-hidden': true,
    color: 'var(--theme-colors-primary)',
    size: 'xs' as const,
};

const clampPct = (n: number) => Math.min(100, Math.max(0, n));

const progressTowardLimit = (current: number, limit: number) =>
    limit > 0 ? clampPct((current / limit) * 100) : 0;

export const ScrobbleStatus = () => {
    const { t } = useTranslation();
    const privateMode = useAppStore((state) => state.privateMode);
    const snapshot = useScrobbleDebugSnapshot();
    const formattedTime = formatDuration(usePlayerTimestamp() * 1000 || 0);

    // One bar now rather than two, because there is one threshold rather than
    // a percentage and a duration racing each other.
    const targetSec = snapshot.targetMs / 1000;
    const listenedSec = snapshot.submitted
        ? targetSec
        : Math.min(snapshot.listenedMs / 1000, targetSec);
    const listenedPct = progressTowardLimit(listenedSec, targetSec);

    return (
        <HoverCard openDelay={500} position="top" width={280}>
            <HoverCard.Target>
                <Group
                    align="center"
                    aria-label={`${t('player.scrobble')}, ${formattedTime}`}
                    fz="xs"
                    gap="sm"
                    justify="center"
                    onClick={(e) => e.stopPropagation()}
                    style={{ userSelect: 'none' }}
                    wrap="nowrap"
                >
                    <Icon
                        aria-hidden
                        color={snapshot.submitted ? 'primary' : 'transparent'}
                        fill={snapshot.submitted ? 'primary' : 'transparent'}
                        icon="circle"
                        size="0.375rem"
                    />
                    <Text
                        className={PlaybackSelectors.elapsedTime}
                        fw={600}
                        fz="inherit"
                        isMuted
                        isNoSelect
                        style={{ userSelect: 'none' }}
                    >
                        {formattedTime}
                    </Text>
                </Group>
            </HoverCard.Target>
            <HoverCard.Dropdown onClick={(e) => e.stopPropagation()}>
                <Stack gap="md" p="sm">
                    {privateMode ? (
                        <Text size="sm">{t('form.privateMode.enabled')}</Text>
                    ) : (
                        <>
                            <Stack gap="xs">
                                <Text size="xs">
                                    {`${listenedSec.toFixed(1)}s / ${targetSec.toFixed(1)}s`}
                                </Text>
                                <Progress {...scrobbleProgressProps} value={listenedPct} w="100%" />
                            </Stack>
                            <Group gap="xs" grow wrap="nowrap">
                                <Button
                                    disabled={!snapshot.songId}
                                    onClick={() => invokeScrobbleResetListenedState()}
                                    size="xs"
                                    variant="outline"
                                >
                                    {t('common.reset')}
                                </Button>
                                <Button
                                    disabled={!snapshot.songId || snapshot.submitted}
                                    onClick={() => invokeScrobbleForceSubmit()}
                                    size="xs"
                                    variant="filled"
                                >
                                    {t('player.scrobbleForceSubmit')}
                                </Button>
                            </Group>
                        </>
                    )}
                </Stack>
            </HoverCard.Dropdown>
        </HoverCard>
    );
};
