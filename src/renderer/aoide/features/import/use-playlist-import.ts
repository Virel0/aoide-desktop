import type { ImportedPlaylist, ImportedTrack } from '/@/shared/aoide/playlist-import';
import type { Song } from '/@/shared/types/domain-types';

import { useCallback, useRef, useState } from 'react';

import { candidateFromSong } from '/@/renderer/aoide/features/import/song-candidate';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { api } from '/@/renderer/api';
import {
    best,
    normalize,
    parsePlaylistCSV,
    PlaylistCSVError,
} from '/@/shared/aoide/playlist-import';
import { SongListSort, SortOrder } from '/@/shared/types/domain-types';

export interface ImportMatch {
    song: null | Song;
    track: ImportedTrack;
}

export type ImportPhase =
    | { done: number; kind: 'matching'; total: number }
    | { key: string; kind: 'failed'; values?: Record<string, string> }
    | { kind: 'finished' }
    | { kind: 'idle' }
    | { kind: 'reading' };

/** Looked up a few at a time: a search is cheap, a hundred at once is a burst. */
const LOOKUPS_AT_ONCE = 4;

/**
 * A playlist in, two lists out.
 *
 * The matching rules are `playlist-import.ts`'s, shared with the phone. This
 * only fetches candidates — Jellyfin's search by the *normalised* title, so the
 * server is not asked for "(Remastered 2009)" — and lets the matcher judge them.
 */
export const usePlaylistImport = (serverId: string) => {
    const [phase, setPhase] = useState<ImportPhase>({ kind: 'idle' });
    const [playlist, setPlaylist] = useState<ImportedPlaylist | null>(null);
    const [matches, setMatches] = useState<ImportMatch[]>([]);
    const run = useRef(0);

    const lookUp = useCallback(
        async (track: ImportedTrack): Promise<null | Song> => {
            const term = normalize(track.title).slice(0, 60);
            if (term.length === 0) return null;
            try {
                const result = await api.controller.getSongList({
                    apiClientProps: { serverId },
                    query: {
                        limit: 15,
                        searchTerm: term,
                        sortBy: SongListSort.NAME,
                        sortOrder: SortOrder.ASC,
                        startIndex: 0,
                    },
                });
                const songs = result?.items ?? [];
                const index = best(track, songs.map(candidateFromSong));
                return index === null ? null : songs[index];
            } catch {
                // A search that fails is a track reported missing, which is the
                // honest answer from here.
                return null;
            }
        },
        [serverId],
    );

    const match = useCallback(
        async (imported: ImportedPlaylist) => {
            const thisRun = (run.current += 1);
            setPlaylist(imported);
            setMatches([]);
            const total = imported.tracks.length;
            setPhase({ done: 0, kind: 'matching', total });

            const results: ImportMatch[] = [];
            for (let at = 0; at < total; at += LOOKUPS_AT_ONCE) {
                const slice = imported.tracks.slice(at, at + LOOKUPS_AT_ONCE);
                const songs = await Promise.all(slice.map(lookUp));
                if (run.current !== thisRun) return;
                slice.forEach((track, offset) => results.push({ song: songs[offset], track }));
                setPhase({ done: results.length, kind: 'matching', total });
            }

            setMatches(results);
            setPhase({ kind: 'finished' });
        },
        [lookUp],
    );

    const importSpotify = useCallback(
        async (link: string) => {
            if (!isAoideAvailable()) return;
            setPhase({ kind: 'reading' });
            const outcome = await window.api.aoide.import.spotify(link);
            if ('playlist' in outcome) {
                await match(outcome.playlist);
            } else {
                setPhase({
                    key: `aoide.import.error.${outcome.reason}`,
                    kind: 'failed',
                    values: { detail: outcome.detail ?? '' },
                });
            }
        },
        [match],
    );

    const importCSV = useCallback(
        async (file: File) => {
            setPhase({ kind: 'reading' });
            try {
                const text = await file.text();
                const name = file.name.replace(/\.[^.]+$/, '');
                await match(parsePlaylistCSV(text, name));
            } catch (error) {
                setPhase({
                    key:
                        error instanceof PlaylistCSVError && error.kind === 'noTitleColumn'
                            ? 'aoide.import.error.csvNoTitle'
                            : 'aoide.import.error.csvUnreadable',
                    kind: 'failed',
                });
            }
        },
        [match],
    );

    const found = matches.flatMap((entry) => (entry.song ? [entry.song] : []));
    const missing = matches.filter((entry) => entry.song === null).map((entry) => entry.track);

    return { found, importCSV, importSpotify, matches, missing, phase, playlist };
};
