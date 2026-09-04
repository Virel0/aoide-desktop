import type { SmartRules } from '/@/shared/aoide/smart-rules';
import type { Song } from '/@/shared/types/domain-types';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import {
    describedGenres,
    describePlan,
    matchGenres,
    missedNamesMessage,
    namesFirst,
    orderCandidates,
    wantsRuleCandidates,
} from '/@/renderer/aoide/features/mix/mix-plan';
import { LibrarySearch, searchNames } from '/@/renderer/aoide/features/mix/name-search';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { api } from '/@/renderer/api';
import { getSongById } from '/@/renderer/features/player/utils';
import { SongListSort, SortOrder } from '/@/shared/types/domain-types';

export interface MixState {
    building: boolean;
    /** Names the description used that the library had nothing for. */
    missed: string[];
    /** What was understood, in one line, after a build. Null before one. */
    plan: null | string;
    /** Rules the model produced that neither app can evaluate, and why. */
    rejected: string[];
    rules: null | SmartRules;
    songs: Song[];
    trouble: null | string;
}

const IDLE: MixState = {
    building: false,
    missed: [],
    plan: null,
    rejected: [],
    rules: null,
    songs: [],
    trouble: null,
};

/**
 * A mix: a mood in, songs out, and the rules that got there.
 *
 * Three steps, and the middle one is the point. The model turns words into
 * **rules**, and lists the things the words *named*. Jellyfin answers the half
 * of those rules that describe the library, and is searched for the names. The
 * curation store answers the half that describes listening. Nothing ever
 * asks a model to name a song, which is why a mix cannot contain a track this
 * library does not have.
 *
 * The rules are kept alongside the songs because they are what makes the result
 * savable — a mix worth keeping becomes a smart playlist holding exactly this
 * JSON, which the phone already evaluates. The names are not saved: a smart
 * playlist has no rule for "the library's search for Helldivers 2", and one
 * that pretended to would evaluate differently on each device.
 */
export const useMix = (serverId: string) => {
    const queryClient = useQueryClient();
    const [state, setState] = useState<MixState>(IDLE);

    const build = useCallback(
        async (description: string, genreNames: string[], genreIdsByName: Map<string, string>) => {
            if (!isAoideAvailable()) return;

            setState({ ...IDLE, building: true });

            const outcome = await window.api.aoide.mix.describe(description, genreNames);

            if (!outcome.rules && outcome.names.length === 0) {
                setState({
                    ...IDLE,
                    rejected: outcome.rejected,
                    trouble: outcome.reason ?? 'The model did not produce any usable rules.',
                });
                return;
            }

            const rules = outcome.rules;

            // The model's genres against the library's, by word — its "rock"
            // is this library's "Rock", "Hard Rock" and "Alternative Rock".
            // Jellyfin takes the ids as a comma list and answers with a track
            // in *any* of them, so three genres widen the mix rather than
            // demanding a track carry all three.
            const genres = matchGenres(describedGenres(rules), genreNames);
            const genreIds = genres
                .map((name) => genreIdsByName.get(name))
                .filter((id): id is string => Boolean(id));

            const plan = describePlan({ genres, names: outcome.names, rules });

            // The names, searched the way the search page searches.
            const named = await searchNames(outcome.names, jellyfinSearch(serverId));

            // The library half. Jellyfin answers these exactly, and asking it for
            // more candidates than the mix needs is what leaves the history
            // something to narrow.
            const candidates =
                rules && wantsRuleCandidates(rules, outcome.names)
                    ? await api.controller.getSongList({
                          apiClientProps: { serverId },
                          query: {
                              genreIds,
                              limit: CANDIDATE_LIMIT,
                              maxYear: numeric(rules, 'year', 'lessThan'),
                              minYear: numeric(rules, 'year', 'greaterThan'),
                              sortBy: SongListSort.RANDOM,
                              sortOrder: SortOrder.ASC,
                              startIndex: 0,
                          },
                      })
                    : undefined;

            const ids = orderCandidates(
                named.ids,
                (candidates?.items ?? []).map((song) => song.id),
            );

            // The listening half, which only this device knows. With no rules
            // at all — a description that was only names — it still drops what
            // was marked "not interested".
            const chosen = namesFirst(
                await window.api.aoide.mix.narrow(ids, rules ?? { match: 'all', rules: [] }),
                new Set(named.ids),
            );

            const songs = (
                await Promise.allSettled(
                    chosen.map((id) => getSongById({ id, queryClient, serverId })),
                )
            ).flatMap((result) => (result.status === 'fulfilled' ? result.value.items : []));

            setState({
                building: false,
                missed: named.missed,
                plan,
                rejected: outcome.rejected,
                rules,
                songs,
                trouble: trouble(songs.length, named.missed),
            });
        },
        [queryClient, serverId],
    );

    return { ...state, build, clear: useCallback(() => setState(IDLE), []) };
};

/**
 * The one line under an empty mix. A miss on the names is the likelier
 * explanation and the more useful one, because it says what to respell.
 */
const trouble = (found: number, missed: readonly string[]): null | string => {
    if (found > 0) return null;
    return missed.length > 0 ? missedNamesMessage(missed) : 'Nothing in your library matched.';
};

/**
 * Feishin's search and song lists, shaped for `searchNames`.
 *
 * The same `api.controller.search` the search page's sections call, with the
 * limits set here rather than the page's four-per-section, and the album and
 * artist follow-ups through `getSongList`'s own `albumIds` and `artistIds`.
 */
const jellyfinSearch = (serverId: string): LibrarySearch => ({
    async search(term) {
        const found = await api.controller.search({
            apiClientProps: { serverId },
            query: {
                albumArtistLimit: ARTISTS_PER_NAME,
                albumArtistStartIndex: 0,
                albumLimit: ALBUMS_PER_NAME,
                albumStartIndex: 0,
                query: term,
                songLimit: SONGS_PER_NAME,
                songStartIndex: 0,
            },
        });

        return {
            albumIds: found.albums.map((album) => album.id),
            artistIds: found.albumArtists.map((artist) => artist.id),
            songIds: found.songs.map((song) => song.id),
        };
    },
    async songsOfAlbums(albumIds, limit) {
        const list = await api.controller.getSongList({
            apiClientProps: { serverId },
            query: {
                albumIds: [...albumIds],
                limit,
                sortBy: SongListSort.ALBUM,
                sortOrder: SortOrder.ASC,
                startIndex: 0,
            },
        });
        return (list?.items ?? []).map((song) => song.id);
    },
    async songsOfArtist(artistId, limit) {
        const list = await api.controller.getSongList({
            apiClientProps: { serverId },
            query: {
                artistIds: [artistId],
                limit,
                sortBy: SongListSort.RANDOM,
                sortOrder: SortOrder.ASC,
                startIndex: 0,
            },
        });
        return (list?.items ?? []).map((song) => song.id);
    },
});

/**
 * How many tracks to ask Jellyfin for before the history narrows them.
 *
 * Generous on purpose: a rule like "not played in six months" can reject most of
 * what arrives, and a mix that asked for exactly fifty would come back with
 * three. Random order, so asking twice for the same mood is not the same mix.
 */
const CANDIDATE_LIMIT = 500;

/** Per name: how many of each kind of hit the search may return. */
const SONGS_PER_NAME = 50;
const ALBUMS_PER_NAME = 10;
const ARTISTS_PER_NAME = 5;

const numeric = (rules: SmartRules, field: string, op: string): number | undefined => {
    const rule = rules.rules.find((candidate) => candidate.field === field && candidate.op === op);
    return typeof rule?.value === 'number' ? rule.value : undefined;
};
