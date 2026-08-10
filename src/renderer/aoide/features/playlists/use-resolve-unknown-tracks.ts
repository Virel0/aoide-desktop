import type { PlaylistTrack, TrackInput } from '/@/main/features/aoide/playlists';
import type { Song } from '/@/shared/types/domain-types';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { aoidePlaylistKeys } from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import { aoidePlaylists, isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { getSongById } from '/@/renderer/features/player/utils';
import { useCurrentServerId } from '/@/renderer/store';

/**
 * Fill in tracks this device knows only by id.
 *
 * The `tracks` cache is per-device and deliberately never synced — keeping it
 * out of the op log is what stops a full history sync growing without bound. The
 * cost is that a playlist arriving from the phone is a list of identifiers: no
 * title, no artist, no artwork, and a row that reads "Track not known to this
 * device".
 *
 * Jellyfin already knows all of it and this app is already signed in, so the
 * missing half is one lookup away. Resolving them here and writing them back
 * means the next open is instant and the one after that works with no server at
 * all.
 *
 * Runs once per set of unknown ids rather than on every render: react-query
 * refetches the item list after the cache is written, which produces a new array
 * with the same ids, and a naive effect would chase its own tail forever.
 */
export const useResolveUnknownTracks = (playlistId: string, tracks: PlaylistTrack[]): void => {
    const queryClient = useQueryClient();
    const serverId = useCurrentServerId();
    const attempted = useRef(new Set<string>());

    useEffect(() => {
        if (!isAoideAvailable()) return;

        const unknown = tracks
            .filter((track) => track.title === null)
            .map((track) => track.jellyfinId)
            .filter((id) => !attempted.current.has(id));

        if (unknown.length === 0) return;

        // Marked before the lookup, not after. A track Jellyfin cannot resolve —
        // deleted, or on a different server — would otherwise be asked for again
        // on every render, forever, and the row is already honest about being
        // unknown.
        for (const id of unknown) attempted.current.add(id);

        let cancelled = false;

        const resolve = async () => {
            const found = await Promise.allSettled(
                unknown.map((id) => getSongById({ id, queryClient, serverId })),
            );

            const songs = found
                .flatMap((result) => (result.status === 'fulfilled' ? result.value.items : []))
                .filter((song): song is Song => Boolean(song));

            if (cancelled || songs.length === 0) return;

            await aoidePlaylists().cacheTracks(songs.map(toTrackInput));

            // The rows are drawn from the store, so the screen only changes once
            // the store has been told.
            await queryClient.invalidateQueries({
                queryKey: aoidePlaylistKeys.items(playlistId),
            });
        };

        void resolve();

        return () => {
            cancelled = true;
        };
    }, [playlistId, queryClient, serverId, tracks]);
};

/**
 * A Feishin song as the curation store wants it.
 *
 * `duration` is seconds on Feishin's side of the app and milliseconds on this
 * one; the conversion is here rather than in the store because this is the
 * boundary between the two vocabularies.
 */
const toTrackInput = (song: Song): TrackInput => ({
    album: song.album ?? '',
    albumArtist: song.albumArtists?.[0]?.name ?? null,
    albumId: song.albumId ?? null,
    artist: song.artists?.[0]?.name ?? song.artistName ?? '',
    durationMs: song.duration === undefined ? null : Math.round(song.duration * 1000),
    genres: song.genres?.map((genre) => genre.name) ?? [],
    jellyfinId: song.id,
    // The recording id, not the track id: a recording is the same performance
    // wherever it was released, which is what a content key is trying to be.
    musicbrainzId: song.mbzRecordingId ?? null,
    title: song.name,
    year: song.releaseYear === undefined ? null : Number(song.releaseYear),
});
