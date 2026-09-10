import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useActivity, useActivityStore } from '/@/renderer/aoide/features/activity/use-activity';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { ACTIVITIES, Activity } from '/@/shared/aoide/activity';
import { Button } from '/@/shared/components/button/button';
import { Paper } from '/@/shared/components/paper/paper';
import { Popover } from '/@/shared/components/popover/popover';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

/**
 * The picker for what the listener is doing, in the player bar.
 *
 * **In the player bar rather than in Settings, and rather than on the Now
 * Playing column.** The tag is set and unset while music is playing — that is
 * the whole shape of the feature — so it has to be reachable in one action from
 * wherever somebody happens to be in the app. The player bar is the only thing
 * on screen at every moment there is something to tag; the Now Playing column
 * is a panel that can be closed, and a control that disappears with it would be
 * missing exactly when a listener sits down and starts playing something. It
 * sits beside Auto DJ because that row is where the player bar's text buttons
 * already live.
 *
 * **The button shows the tag rather than only an icon.** A tag left on is the
 * failure this design has to prevent: an evening of gaming tagged correctly and
 * then a fortnight of work quietly filed under Gaming is worse than no tag at
 * all, because the data looks fine. The label is the reminder, and None is
 * offered first in the list and always enabled, so taking it off is as cheap as
 * putting it on.
 *
 * Nothing here reads history back. Play events carry the tag from today; what
 * asks about them — smart rules, a Replay split by activity, the crossfader —
 * comes later, and would have nothing to work with if the recording had waited
 * for it.
 */
export const AoideActivityButton = () =>
    // The web and remote builds have no main process, so no play events are
    // being recorded there at all; a picker that tagged nothing would be a
    // control that lies.
    isAoideAvailable() ? <ActivityButton /> : null;

const ActivityButton = () => {
    const { t } = useTranslation();
    const activity = useActivity();
    const setActivity = useActivityStore((state) => state.setActivity);
    const [opened, setOpened] = useState(false);

    const choose = (next: Activity | null) => {
        setActivity(next);
        setOpened(false);
    };

    return (
        <Popover onChange={setOpened} opened={opened} position="top-end" withArrow>
            <Popover.Target>
                <Button
                    onClick={(e) => {
                        e.stopPropagation();
                        setOpened((previous) => !previous);
                    }}
                    size="compact-xs"
                    style={{ color: activity ? 'var(--theme-colors-primary)' : undefined }}
                    uppercase
                    variant="transparent"
                >
                    {activity ? t(`aoide.activity.${activity}`) : t('aoide.activity.title')}
                </Button>
            </Popover.Target>
            <Popover.Dropdown maw={320} miw={220} onClick={(e) => e.stopPropagation()} p="sm">
                <Stack gap="sm">
                    <Paper p="md" radius="md">
                        <Stack gap="xs">
                            <Text fw={600} size="sm" ta="center">
                                {t('aoide.activity.title')}
                            </Text>
                            <Text isMuted size="xs" ta="center">
                                {t('aoide.activity.description')}
                            </Text>
                        </Stack>
                    </Paper>
                    <Stack gap="xs">
                        {/*
                         * First and always offered, never hidden behind the
                         * absence of a selection: the point of the list is that
                         * turning the tag off is one click from anywhere.
                         */}
                        <Button
                            fullWidth
                            justify="center"
                            onClick={(e) => {
                                e.stopPropagation();
                                choose(null);
                            }}
                            variant={activity === null ? 'filled' : 'outline'}
                        >
                            {t('aoide.activity.none')}
                        </Button>
                        {ACTIVITIES.map((option) => (
                            <Button
                                fullWidth
                                justify="center"
                                key={option}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    choose(option);
                                }}
                                variant={activity === option ? 'filled' : 'outline'}
                            >
                                {t(`aoide.activity.${option}`)}
                            </Button>
                        ))}
                    </Stack>
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};
