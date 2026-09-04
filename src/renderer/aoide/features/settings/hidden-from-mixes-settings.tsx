import type { FlaggedTrack } from '/@/main/features/aoide/track-flags';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { notifyAoideError } from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import {
    useClearTrackFlags,
    useFlaggedTracks,
} from '/@/renderer/aoide/features/taste/taste-flags-api';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

/**
 * Every track the listener has flagged, so a flag can be found and undone.
 *
 * In Settings rather than beside the tracks, because the whole point of "not
 * interested" is that the track stops turning up — which would otherwise make
 * the flag impossible to find again. The phone's "Hidden from Mixes" screen,
 * mounted from the general tab the way the other Aoide sections are.
 *
 * A track flagged on the phone that this device has never cached is listed by
 * its id: it is hidden here all the same, and hiding the row too would hide
 * the only way to clear it.
 */
export const HiddenFromMixesSettings = memo(() => {
    const { t } = useTranslation();
    const flaggedQuery = useFlaggedTracks();
    const clear = useClearTrackFlags();

    // The web and remote builds have no store, so nothing can be flagged.
    if (!isAoideAvailable()) return null;

    const flagged = flaggedQuery.data ?? [];

    const detail = (entry: FlaggedTrack): string =>
        [
            entry.artist,
            entry.notInterested ? t('aoide.taste.flagNotInterested') : null,
            entry.dontCount ? t('aoide.taste.flagDontCount') : null,
        ]
            .filter((part): part is string => Boolean(part))
            .join(' · ');

    const list =
        flagged.length === 0 ? (
            <Text isMuted size="sm">
                {t('aoide.taste.empty')}
            </Text>
        ) : (
            <Stack gap="sm">
                {flagged.map((entry) => (
                    <Group gap="sm" justify="space-between" key={entry.id} wrap="nowrap">
                        <Stack gap={0} style={{ minWidth: 0 }}>
                            <Text overflow="hidden" size="sm">
                                {entry.title ?? entry.jellyfinId}
                            </Text>
                            <Text isMuted overflow="hidden" size="xs">
                                {detail(entry)}
                            </Text>
                        </Stack>
                        <Button
                            onClick={() =>
                                clear.mutate(entry.jellyfinId, {
                                    onError: (error) =>
                                        notifyAoideError(error, t('aoide.taste.error')),
                                })
                            }
                            size="compact-sm"
                            variant="subtle"
                        >
                            {t('aoide.settings.clear')}
                        </Button>
                    </Group>
                ))}
            </Stack>
        );

    const options: SettingOption[] = [
        {
            control: list,
            description: t('aoide.settings.hiddenFromMixes', { context: 'description' }),
            title: t('aoide.settings.hiddenFromMixes'),
        },
    ];

    return <SettingsSection options={options} />;
});
