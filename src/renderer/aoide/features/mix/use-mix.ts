import type { SmartRules } from '/@/shared/aoide/smart-rules';
import type { Song } from '/@/shared/types/domain-types';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { api } from '/@/renderer/api';
import { getSongById } from '/@/renderer/features/player/utils';
import { SongListSort, SortOrder } from '/@/shared/types/domain-types';

export interface MixState {
    building: boolean;
    /** Rules the model produced that neither app can evaluate, and why. */
    rejected: string[];
    rules: null | SmartRules;
    songs: Song[];
    trouble: null | string;
}

const IDLE: MixState = { building: false, rejected: [], rules: null, songs: [], trouble: null };

/**
 * A mix: a mood in, songs out, and the rules that got there.
 *
 * Three steps, and the middle one is the point. The model turns words into
 * **rules**. Jellyfin answers the half of those rules that describe the library.
 * The curation store answers the half that describes listening. Nothing ever
 * asks a model to name a song, which is why a mix cannot contain a track this
 * library does not have.
 *
 * The rules are kept alongside the songs because they are what makes the result
 * savable — a mix worth keeping becomes a smart playlist holding exactly this
 * JSON, which the phone already evaluates.
 */
export const useMix = (serverId: string) => {
    const queryClient = useQueryClient();
    const [state, setState] = useState<MixState>(IDLE);

    const build = useCallback(
        async (description: string, genreNames: string[], genreIdsByName: Map<string, string>) => {
            if (!isAoideAvailable()) return;

            setState({ ...IDLE, building: true });

            const outcome = await window.api.aoide.mix.describe(description, genreNames);

            if (!outcome.rules) {
                setState({
                    ...IDLE,
                    rejected: outcome.rejected,
                    trouble: outcome.reason ?? 'The model did not produce any usable rules.',
                });
                return;
            }

            const rules = outcome.rules;

            // The library half. Jellyfin answers these exactly, and asking it for
            // more candidates than the mix needs is what leaves the history
            // something to narrow.
            const candidates = await api.controller.getSongList({
                apiClientProps: { serverId },
                query: {
                    genreIds: rules.rules
                        .filter((rule) => rule.field === 'genre' && rule.op === 'is')
                        .map((rule) => genreIdsByName.get(String(rule.value)))
                        .filter((id): id is string => Boolean(id)),
                    limit: CANDIDATE_LIMIT,
                    maxYear: numeric(rules, 'year', 'lessThan'),
                    minYear: numeric(rules, 'year', 'greaterThan'),
                    sortBy: SongListSort.RANDOM,
                    sortOrder: SortOrder.ASC,
                    startIndex: 0,
                },
            });

            const ids = (candidates?.items ?? []).map((song) => song.id);

            // The listening half, which only this device knows.
            const chosen = await window.api.aoide.mix.narrow(ids, rules);

            const songs = (
                await Promise.allSettled(
                    chosen.map((id) => getSongById({ id, queryClient, serverId })),
                )
            ).flatMap((result) => (result.status === 'fulfilled' ? result.value.items : []));

            setState({
                building: false,
                rejected: outcome.rejected,
                rules,
                songs,
                trouble: songs.length === 0 ? 'Nothing in your library matched.' : null,
            });
        },
        [queryClient, serverId],
    );

    return { ...state, build, clear: useCallback(() => setState(IDLE), []) };
};

/**
 * How many tracks to ask Jellyfin for before the history narrows them.
 *
 * Generous on purpose: a rule like "not played in six months" can reject most of
 * what arrives, and a mix that asked for exactly fifty would come back with
 * three. Random order, so asking twice for the same mood is not the same mix.
 */
const CANDIDATE_LIMIT = 500;

const numeric = (rules: SmartRules, field: string, op: string): number | undefined => {
    const rule = rules.rules.find((candidate) => candidate.field === field && candidate.op === op);
    return typeof rule?.value === 'number' ? rule.value : undefined;
};
