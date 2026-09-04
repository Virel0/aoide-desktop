import type { SidecarMatch } from '/@/renderer/aoide/sync/sidecar-client';
import type { ImportedPlaylist, ImportedTrack } from '/@/shared/aoide/playlist-import';
import type { Song } from '/@/shared/types/domain-types';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { candidateFromSong } from '/@/renderer/aoide/features/import/song-candidate';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { useSidecarTransport } from '/@/renderer/aoide/features/sync/use-sidecar-transport';
import { api } from '/@/renderer/api';
import { getSongById } from '/@/renderer/features/player/utils';
import {
    best,
    parsePlaylistCSV,
    PlaylistCSVError,
    searchTerms,
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
    const transport = useSidecarTransport();
    const queryClient = useQueryClient();
    const [phase, setPhase] = useState<ImportPhase>({ kind: 'idle' });
    const [playlist, setPlaylist] = useState<ImportedPlaylist | null>(null);
    const [matches, setMatches] = useState<ImportMatch[]>([]);
    const run = useRef(0);

    const lookUp = useCallback(
        async (track: ImportedTrack): Promise<null | Song> => {
            // Asked in the title's own spelling first, then wider. See `searchTerms`.
            for (const term of searchTerms(track.title)) {
                try {
                    const result = await api.controller.getSongList({
                        apiClientProps: { serverId },
                        query: {
                            limit: 40,
                            searchTerm: term.slice(0, 60),
                            sortBy: SongListSort.NAME,
                            sortOrder: SortOrder.ASC,
                            startIndex: 0,
                        },
                    });
                    const songs = result?.items ?? [];
                    const index = best(track, songs.map(candidateFromSong));
                    if (index !== null) return songs[index];
                } catch {
                    // A search that fails is a track reported missing, which is
                    // the honest answer from here.
                    return null;
                }
            }
            return null;
        },
        [serverId],
    );

    /**
     * The sidecar's answers, as rows this screen can show and save — or null
     * when there is no sidecar, or it failed, and the lookups below must do it.
     */
    const matchOnServer = useCallback(
        async (imported: ImportedPlaylist): Promise<ImportMatch[] | null> => {
            if (!transport) return null;
            let answers: Array<null | SidecarMatch>;
            try {
                answers = await transport.match(imported.tracks);
            } catch {
                return null;
            }
            if (answers.length !== imported.tracks.length) return null;

            // The sidecar names ids; the songs are fetched by id, a few at a
            // time, which is one request per hit rather than several per track.
            const songs = new Map<string, Song>();
            const ids = [
                ...new Set(answers.flatMap((answer) => (answer ? [answer.jellyfinId] : []))),
            ];
            for (let at = 0; at < ids.length; at += LOOKUPS_AT_ONCE) {
                const fetched = await Promise.allSettled(
                    ids
                        .slice(at, at + LOOKUPS_AT_ONCE)
                        .map((id) => getSongById({ id, queryClient, serverId })),
                );
                for (const result of fetched) {
                    if (result.status === 'fulfilled') {
                        for (const song of result.value.items) songs.set(song.id, song);
                    }
                }
            }
            return imported.tracks.map((track, index) => {
                const answer = answers[index];
                return { song: answer ? (songs.get(answer.jellyfinId) ?? null) : null, track };
            });
        },
        [queryClient, serverId, transport],
    );

    const match = useCallback(
        async (imported: ImportedPlaylist) => {
            const thisRun = (run.current += 1);
            setPlaylist(imported);
            setMatches([]);
            const total = imported.tracks.length;
            setPhase({ done: 0, kind: 'matching', total });

            // The sidecar first: one request, answered from inside the library
            // by the same rules this device would apply. Without it, the same
            // answer, only slower.
            const served = await matchOnServer(imported);
            if (run.current !== thisRun) return;
            if (served) {
                setMatches(served);
                setPhase({ kind: 'finished' });
                return;
            }

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
        [lookUp, matchOnServer],
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

    const importCsvText = useCallback(
        async (text: string, name: string) => {
            setPhase({ kind: 'reading' });
            try {
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

    const importCSV = useCallback(
        async (file: File) => importCsvText(await file.text(), file.name.replace(/\.[^.]+$/, '')),
        [importCsvText],
    );

    // Exportify, opened in its own window, saves a CSV; the main process catches
    // it and hands it here, so the person never touches a file.
    useEffect(() => {
        if (!isAoideAvailable()) return undefined;
        return window.api.aoide.import.onCsv((file) => void importCsvText(file.text, file.name));
    }, [importCsvText]);

    const openExportify = useCallback(() => {
        if (!isAoideAvailable()) return;
        void window.api.aoide.import.openExportify();
    }, []);

    const found = matches.flatMap((entry) => (entry.song ? [entry.song] : []));
    const missing = matches.filter((entry) => entry.song === null).map((entry) => entry.track);

    return { found, importCSV, importSpotify, matches, missing, openExportify, phase, playlist };
};
