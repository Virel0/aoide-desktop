import { useTranslation } from 'react-i18next';

import { notifyAoideError } from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import { trackInputFromSong } from '/@/renderer/aoide/features/playlists/track-input';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { useSetTrackFlag, useTrackFlags } from '/@/renderer/aoide/features/taste/taste-flags-api';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { Song } from '/@/shared/types/domain-types';

/**
 * "Not Interested" and "Don't Count Plays", beside "Add to Aoide playlist".
 *
 * The phone's `TasteFlagButtons`, entry for entry: each item reads as the
 * action it will take, so a flagged track offers "Offer This Again" and
 * "Count Plays" rather than a tick beside the same words. One track at a time
 * — the flags are a judgement about a song, and a menu over a selection of
 * twenty is not where that judgement is made — so the items are disabled, not
 * hidden, for more than one, like the track radio beside them.
 *
 * The current flags come through react-query, so the menu opens with the right
 * words and every other reader of the flag sees the change: the mutation
 * invalidates the whole `['aoide', 'flags']` subtree.
 */
interface TasteFlagActionsProps {
    songs: Song[];
}

export const TasteFlagActions = ({ songs }: TasteFlagActionsProps) => {
    const { t } = useTranslation();
    const song = songs.length === 1 ? songs[0] : undefined;
    const flagsQuery = useTrackFlags(song?.id);
    const setFlag = useSetTrackFlag();

    if (!isAoideAvailable() || songs.length === 0) return null;

    const notInterested = flagsQuery.data?.notInterested === true;
    const dontCount = flagsQuery.data?.dontCount === true;

    const toggle = (flag: 'dontCount' | 'notInterested', value: boolean) => {
        if (!song) return;
        setFlag.mutate(
            { flag, track: trackInputFromSong(song), value },
            { onError: (error) => notifyAoideError(error, t('aoide.taste.error')) },
        );
    };

    return (
        <>
            <ContextMenu.Item
                disabled={!song}
                leftIcon={notInterested ? 'visibility' : 'visibilityOff'}
                onSelect={() => toggle('notInterested', !notInterested)}
            >
                {notInterested ? t('aoide.taste.offerAgain') : t('aoide.taste.notInterested')}
            </ContextMenu.Item>
            <ContextMenu.Item
                disabled={!song}
                leftIcon="hash"
                onSelect={() => toggle('dontCount', !dontCount)}
            >
                {dontCount ? t('aoide.taste.countPlays') : t('aoide.taste.dontCount')}
            </ContextMenu.Item>
        </>
    );
};
