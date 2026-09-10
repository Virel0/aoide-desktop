import { useTranslation } from 'react-i18next';

import {
    useAlbumFinishRate,
    useArtistFinishRate,
} from '/@/renderer/aoide/features/finish-rate/use-finish-rate';
import { Separator } from '/@/shared/components/separator/separator';
import { Text } from '/@/shared/components/text/text';

/**
 * One quiet sentence at the end of a detail page's metadata line.
 *
 * A sentence rather than a number tile on purpose. "78%" on its own is a figure
 * whose meaning has to be guessed at — a rating, a match, a loudness — while
 * "You finish 78% of this album" is a thing a person would say out loud, and it
 * costs the page one more item in a row it already has.
 *
 * **When there is no figure it renders nothing at all** — no dash, no "not
 * enough plays yet", not even the separator that would precede it. That is the
 * point of the floor in `finish-rate.ts`: a listener who has played a record
 * twice has not told the app anything about themselves, and a slot on the page
 * saying so would be the app talking about its own data collection instead of
 * about their music.
 *
 * It carries its own separator because it is always last on the line. The pages
 * put their separator *before* each item after the first, and a component that
 * disappears on its own would otherwise leave a dangling one behind it.
 */

interface AoideAlbumFinishRateProps {
    /** Every track on the record. The rate is their counts summed, not their rates averaged. */
    jellyfinIds: readonly string[];
}

interface AoideArtistFinishRateProps {
    /** The name the page is showing, which is what the track cache is searched by. */
    artist: string | undefined;
}

export const AoideAlbumFinishRate = ({ jellyfinIds }: AoideAlbumFinishRateProps) => {
    const { t } = useTranslation();
    const percent = useAlbumFinishRate(jellyfinIds);

    if (percent === undefined) return null;
    return <FinishRateNote text={t('aoide.finishRate.album', { percent })} />;
};

export const AoideArtistFinishRate = ({ artist }: AoideArtistFinishRateProps) => {
    const { t } = useTranslation();
    const percent = useArtistFinishRate(artist);

    if (percent === undefined) return null;
    return <FinishRateNote text={t('aoide.finishRate.artist', { percent })} />;
};

const FinishRateNote = ({ text }: { text: string }) => (
    <>
        <Text isMuted isNoSelect>
            <Separator />
        </Text>
        <Text fw={400}>{text}</Text>
    </>
);
