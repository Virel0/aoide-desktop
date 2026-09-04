import { useTranslation } from 'react-i18next';

import styles from './resume-grid.module.css';

import {
    RecentContext,
    RESUME_GRID_LIMIT,
    resumeTiles,
} from '/@/renderer/aoide/features/home/recent-contexts';
import { useRecentContexts } from '/@/renderer/aoide/features/home/use-recent-contexts';
import { useResumeContext } from '/@/renderer/aoide/features/home/use-resume-context';
import { useAoidePlaylist } from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import { usePlaylistCoverOrFirstTrack } from '/@/renderer/aoide/features/playlists/use-playlist-cover';
import { useHandoff } from '/@/renderer/aoide/features/queue/use-queue-handoff';
import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { useCurrentServerId } from '/@/renderer/store';
import { AppIcon, Icon } from '/@/shared/components/icon/icon';
import { Text } from '/@/shared/components/text/text';
import { LibraryItem } from '/@/shared/types/domain-types';

/** What a tile draws. Doubled for a high-density screen. */
const TILE_ARTWORK_WIDTH = 320;

/**
 * Home opens on the last six things you were in, each one tap from playing.
 *
 * Albums, playlists of both kinds, mixes and stations, newest first — and
 * another device's queue first of all when it played more recently than any
 * of them, using the same pick-up the sync panel offers. With nothing to
 * show it renders nothing: a placeholder saying "play something" on a page
 * that is already full of things to play would only push them down.
 */
export const ResumeGrid = () => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const recent = useRecentContexts(serverId, RESUME_GRID_LIMIT);
    const handoff = useHandoff();
    const { resume, resumeHandoff } = useResumeContext();

    // "Now" is when the handoff's age was measured, not when this renders.
    const tiles = resumeTiles(recent, handoff, handoff?.receivedAt ?? 0, RESUME_GRID_LIMIT);

    if (tiles.length === 0) return null;

    return (
        <section aria-label={t('aoide.home.resume')} className={styles.grid}>
            {tiles.map((tile) =>
                tile.kind === 'handoff' ? (
                    <Tile
                        icon="mediaPlay"
                        key="handoff"
                        kindLabel={t('aoide.home.kind_handoff')}
                        name={t('aoide.home.pickUpFrom', { device: tile.deviceName })}
                        onClick={() => handoff && void resumeHandoff(handoff)}
                    />
                ) : (
                    <ContextTile
                        context={tile.context}
                        key={`${tile.context.kind}:${tile.context.id}`}
                        onClick={() => void resume(tile.context)}
                    />
                ),
            )}
        </section>
    );
};

interface ContextTileProps {
    context: RecentContext;
    onClick: () => void;
}

/**
 * One context, drawn with whatever picture it has. Aoide playlists find
 * theirs through the cover hook; everything Jellyfin holds is rebuilt from
 * its id. Split into two components so each calls only its own hooks.
 */
const ContextTile = ({ context, onClick }: ContextTileProps) =>
    context.kind === 'aoidePlaylist' ? (
        <AoidePlaylistTile context={context} onClick={onClick} />
    ) : (
        <JellyfinTile context={context} onClick={onClick} />
    );

const JellyfinTile = ({ context, onClick }: ContextTileProps) => {
    const { t } = useTranslation();
    const built = useItemImageUrl({
        id: context.kind === 'mix' ? undefined : context.id,
        itemType: itemTypeFor(context),
        size: TILE_ARTWORK_WIDTH,
    });

    return (
        <Tile
            artworkUrl={context.artworkUrl ?? built}
            icon={iconFor(context)}
            kindLabel={t(`aoide.home.kind_${context.kind}`)}
            name={context.name}
            onClick={onClick}
            subtitle={context.subtitle}
        />
    );
};

const EMPTY_COVER = {
    artworkItemId: null,
    firstTrack: null,
    imageHash: null,
    imageMime: null,
    sourceJellyfinId: null,
};

const AoidePlaylistTile = ({ context, onClick }: ContextTileProps) => {
    const { t } = useTranslation();
    const playlist = useAoidePlaylist(context.id);
    const cover = usePlaylistCoverOrFirstTrack(playlist.data ?? EMPTY_COVER, TILE_ARTWORK_WIDTH);

    return (
        <Tile
            artworkUrl={context.artworkUrl ?? cover ?? undefined}
            icon="playlist"
            kindLabel={t('aoide.home.kind_aoidePlaylist')}
            name={playlist.data?.name ?? context.name}
            onClick={onClick}
        />
    );
};

const itemTypeFor = (context: RecentContext): LibraryItem => {
    switch (context.kind) {
        case 'jellyfinPlaylist':
            return LibraryItem.PLAYLIST;
        case 'station':
            return context.seed === 'artist' ? LibraryItem.ALBUM_ARTIST : LibraryItem.ALBUM;
        default:
            return LibraryItem.ALBUM;
    }
};

const iconFor = (context: RecentContext): keyof typeof AppIcon => {
    switch (context.kind) {
        case 'jellyfinPlaylist':
            return 'playlist';
        case 'mix':
            return 'mediaShuffle';
        case 'station':
            return 'radio';
        default:
            return 'album';
    }
};

interface TileProps {
    artworkUrl?: string;
    icon: keyof typeof AppIcon;
    kindLabel: string;
    name: string;
    onClick: () => void;
    subtitle?: string;
}

const Tile = ({ artworkUrl, icon, kindLabel, name, onClick, subtitle }: TileProps) => (
    <button className={styles.tile} onClick={onClick} type="button">
        <div className={styles.artwork}>
            {artworkUrl ? (
                <img alt="" className={styles.artworkImage} src={artworkUrl} />
            ) : (
                <Icon color="muted" icon={icon} size="2xl" />
            )}
            <span className={styles.play}>
                <Icon fill="default" icon="mediaPlay" size="md" />
            </span>
        </div>
        <div className={styles.text}>
            <Text className={styles.name} fw={600} overflow="hidden" size="sm">
                {name}
            </Text>
            <Text className={styles.kind} isMuted overflow="hidden" size="xs">
                {subtitle ? `${kindLabel} · ${subtitle}` : kindLabel}
            </Text>
        </div>
    </button>
);
